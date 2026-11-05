import Foundation
import AppKit
import CoreGraphics
import CoreMedia
import AudioToolbox
import ScreenCaptureKit
import Darwin

struct ProcessEntry: Codable {
	let Id: Int32
	let ProcessName: String
	let MainWindowTitle: String
}

struct WindowOwnerEntry: Codable {
	let handle: String
	let owner: String
}

struct ProbeInfo: Codable {
	let backend: String
	let macosVersion: String
	let majorVersion: Int
	let arch: String
	let sampleRate: Int
	let channels: Int
	let bitsPerSample: Int
}

func currentArch() -> String {
	#if arch(arm64)
	return "arm64"
	#elseif arch(x86_64)
	return "x64"
	#else
	return "unknown"
	#endif
}

func descendantPids(of rootPid: pid_t) -> Set<pid_t> {
	var result: Set<pid_t> = [rootPid]
	var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
	var size: Int = 0
	guard sysctl(&mib, 4, nil, &size, nil, 0) == 0, size > 0 else {
		return result
	}
	let count = size / MemoryLayout<kinfo_proc>.stride
	var procs = Array<kinfo_proc>(repeating: kinfo_proc(), count: count)
	var actualSize = size
	guard sysctl(&mib, 4, &procs, &actualSize, nil, 0) == 0 else {
		return result
	}
	let actualCount = actualSize / MemoryLayout<kinfo_proc>.stride
	var childrenByParent: [pid_t: [pid_t]] = [:]
	for i in 0..<actualCount {
		let child = procs[i].kp_proc.p_pid
		let parent = procs[i].kp_eproc.e_ppid
		if child > 0 {
			childrenByParent[parent, default: []].append(child)
		}
	}
	var queue: [pid_t] = [rootPid]
	while let current = queue.popLast() {
		for child in childrenByParent[current] ?? [] {
			if result.insert(child).inserted {
				queue.append(child)
			}
		}
	}
	return result
}

func processExists(_ pid: pid_t) -> Bool {
	if pid <= 0 { return false }
	if kill(pid, 0) == 0 { return true }
	return errno == EPERM
}

func cleanLabel(_ raw: String) -> String {
	let invisible: Set<UnicodeScalar> = ["\u{200E}", "\u{200F}", "\u{202A}", "\u{202B}", "\u{202C}", "\u{202D}", "\u{202E}"]
	let filtered = String.UnicodeScalarView(raw.unicodeScalars.filter { !invisible.contains($0) })
	return String(filtered).trimmingCharacters(in: .whitespacesAndNewlines)
}

func listAppsJson() async throws -> String {
	let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
	var titlesByPid: [Int32: String] = [:]
	var ownerNamesByPid: [Int32: String] = [:]

	for info in windowList {
		guard let pid = info[kCGWindowOwnerPID as String] as? Int32, pid > 0 else { continue }
		let layer = info[kCGWindowLayer as String] as? Int ?? 0
		if layer != 0 { continue }
		if let ownerName = info[kCGWindowOwnerName as String] as? String {
			let cleaned = cleanLabel(ownerName)
			if !cleaned.isEmpty, ownerNamesByPid[pid] == nil {
				ownerNamesByPid[pid] = cleaned
			}
		}
		if let title = info[kCGWindowName as String] as? String {
			let cleaned = cleanLabel(title)
			if !cleaned.isEmpty, titlesByPid[pid] == nil {
				titlesByPid[pid] = cleaned
			}
		}
	}

	if CGPreflightScreenCaptureAccess() {
		if let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) {
			for win in content.windows {
				guard let app = win.owningApplication, app.processID > 0 else { continue }
				if let title = win.title {
					let cleaned = cleanLabel(title)
					if !cleaned.isEmpty, titlesByPid[app.processID] == nil {
						titlesByPid[app.processID] = cleaned
					}
				}
			}
		}
	}

	var entriesByPid: [Int32: ProcessEntry] = [:]
	for app in NSWorkspace.shared.runningApplications {
		let pid = app.processIdentifier
		guard pid > 0, !app.isTerminated else { continue }
		let isRegular = app.activationPolicy == .regular
		let hasWindow = ownerNamesByPid[pid] != nil
		guard isRegular || hasWindow else { continue }
		let rawName = app.localizedName ?? ownerNamesByPid[pid] ?? app.bundleIdentifier ?? "App-\(pid)"
		let name = cleanLabel(rawName)
		let rawTitle = titlesByPid[pid] ?? app.bundleIdentifier ?? name
		let title = cleanLabel(rawTitle)
		entriesByPid[pid] = ProcessEntry(Id: pid, ProcessName: name.isEmpty ? "App-\(pid)" : name, MainWindowTitle: title)
	}

	for (pid, ownerName) in ownerNamesByPid where entriesByPid[pid] == nil {
		let title = titlesByPid[pid] ?? ownerName
		entriesByPid[pid] = ProcessEntry(Id: pid, ProcessName: ownerName, MainWindowTitle: title)
	}

	let sorted = entriesByPid.values.sorted {
		let cmp = $0.ProcessName.localizedCaseInsensitiveCompare($1.ProcessName)
		if cmp == .orderedSame { return $0.Id < $1.Id }
		return cmp == .orderedAscending
	}
	let data = try JSONEncoder().encode(sorted)
	return String(data: data, encoding: .utf8) ?? "[]"
}

func resolveWindowsJson(_ rawHandles: String) throws -> String {
	let requested = Set(
		rawHandles
			.split(separator: ",")
			.compactMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
	)
	if requested.isEmpty { return "[]" }

	let windowList = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
	var results: [WindowOwnerEntry] = []
	var seen = Set<Int32>()

	for info in windowList {
		guard
			let number = info[kCGWindowNumber as String] as? Int32,
			requested.contains(number),
			!seen.contains(number),
			let ownerPid = info[kCGWindowOwnerPID as String] as? Int32,
			ownerPid > 0
		else { continue }
		seen.insert(number)
		results.append(WindowOwnerEntry(handle: String(number), owner: String(ownerPid)))
	}
	let data = try JSONEncoder().encode(results)
	return String(data: data, encoding: .utf8) ?? "[]"
}

final class AudioCaptureOutput: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
	private let writeLock = NSLock()

	func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
		guard outputType == .audio, CMSampleBufferIsValid(sampleBuffer) else { return }
		let numSamples = CMSampleBufferGetNumSamples(sampleBuffer)
		guard numSamples > 0 else { return }
		guard
			let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
			let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)
		else { return }
		let asbd = asbdPtr.pointee
		let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
		let isNonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
		let channels = max(1, Int(asbd.mChannelsPerFrame))

		var blockBuffer: CMBlockBuffer?
		let bufferListSize = MemoryLayout<AudioBufferList>.size + MemoryLayout<AudioBuffer>.stride * max(0, channels - 1)
		let rawPtr = UnsafeMutableRawPointer.allocate(byteCount: bufferListSize, alignment: MemoryLayout<AudioBufferList>.alignment)
		defer { rawPtr.deallocate() }
		let audioBufferListPtr = rawPtr.bindMemory(to: AudioBufferList.self, capacity: 1)

		let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
			sampleBuffer,
			bufferListSizeNeededOut: nil,
			bufferListOut: audioBufferListPtr,
			bufferListSize: bufferListSize,
			blockBufferAllocator: nil,
			blockBufferMemoryAllocator: nil,
			flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
			blockBufferOut: &blockBuffer
		)
		guard status == noErr else { return }

		let buffers = UnsafeMutableAudioBufferListPointer(audioBufferListPtr)
		guard !buffers.isEmpty else { return }

		var out = Data(count: numSamples * 4)
		out.withUnsafeMutableBytes { rawOut in
			guard let outSamples = rawOut.bindMemory(to: Int16.self).baseAddress else { return }

			if isFloat {
				if isNonInterleaved || buffers.count >= 2 {
					guard let leftPtr = buffers[0].mData?.assumingMemoryBound(to: Float32.self) else { return }
					let rightPtr = (buffers.count >= 2 ? buffers[1].mData?.assumingMemoryBound(to: Float32.self) : nil) ?? leftPtr
					for i in 0..<numSamples {
						let l = max(-1.0, min(1.0, leftPtr[i]))
						let r = max(-1.0, min(1.0, rightPtr[i]))
						outSamples[i * 2] = Int16(l * 32767.0).littleEndian
						outSamples[i * 2 + 1] = Int16(r * 32767.0).littleEndian
					}
				} else {
					guard let interleavedPtr = buffers[0].mData?.assumingMemoryBound(to: Float32.self) else { return }
					for i in 0..<numSamples {
						let l = max(-1.0, min(1.0, interleavedPtr[i * channels]))
						let r = max(-1.0, min(1.0, interleavedPtr[i * channels + (channels > 1 ? 1 : 0)]))
						outSamples[i * 2] = Int16(l * 32767.0).littleEndian
						outSamples[i * 2 + 1] = Int16(r * 32767.0).littleEndian
					}
				}
			} else {
				if isNonInterleaved || buffers.count >= 2 {
					guard let leftPtr = buffers[0].mData?.assumingMemoryBound(to: Int16.self) else { return }
					let rightPtr = (buffers.count >= 2 ? buffers[1].mData?.assumingMemoryBound(to: Int16.self) : nil) ?? leftPtr
					for i in 0..<numSamples {
						outSamples[i * 2] = leftPtr[i].littleEndian
						outSamples[i * 2 + 1] = rightPtr[i].littleEndian
					}
				} else {
					guard let interleavedPtr = buffers[0].mData?.assumingMemoryBound(to: Int16.self) else { return }
					for i in 0..<numSamples {
						outSamples[i * 2] = interleavedPtr[i * channels].littleEndian
						outSamples[i * 2 + 1] = interleavedPtr[i * channels + (channels > 1 ? 1 : 0)].littleEndian
					}
				}
			}
		}

		writeLock.lock()
		defer { writeLock.unlock() }
		try? FileHandle.standardOutput.write(contentsOf: out)
	}

	func stream(_ stream: SCStream, didStopWithError error: Error) {
		fputs("STREAM_ERROR: \(error.localizedDescription)\n", stderr)
		exit(1)
	}
}

func runCapture(mode: String, targetPid: pid_t?) async throws {
	if let pid = targetPid, !processExists(pid) {
		throw NSError(domain: "MygleTVAudio", code: 2, userInfo: [NSLocalizedDescriptionKey: "Choose a valid application process."])
	}

	let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
	guard let display = content.displays.first else {
		throw NSError(domain: "MygleTVAudio", code: 3, userInfo: [NSLocalizedDescriptionKey: "No display available for ScreenCaptureKit audio capture."])
	}

	let filter: SCContentFilter
	if mode == "system" {
		filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
	} else if let pid = targetPid {
		let treePids = descendantPids(of: pid)
		let matchingApps = content.applications.filter { treePids.contains($0.processID) }
		if !matchingApps.isEmpty {
			filter = SCContentFilter(display: display, including: matchingApps, exceptingWindows: [])
		} else {
			let currentPid = ProcessInfo.processInfo.processIdentifier
			let excluded = content.applications.filter { !treePids.contains($0.processID) && $0.processID != currentPid }
			filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
		}
	} else {
		throw NSError(domain: "MygleTVAudio", code: 4, userInfo: [NSLocalizedDescriptionKey: "Missing target process ID."])
	}

	let config = SCStreamConfiguration()
	config.capturesAudio = true
	config.sampleRate = 48000
	config.channelCount = 2
	config.excludesCurrentProcessAudio = true
	config.width = 2
	config.height = 2
	config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

	let output = AudioCaptureOutput()
	let stream = SCStream(filter: filter, configuration: config, delegate: output)
	let audioQueue = DispatchQueue(label: "com.mygletv.macos.audio-capture", qos: .userInteractive)
	try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: audioQueue)
	try await stream.startCapture()

	fputs("READY\n", stderr)
	fflush(stderr)

	let stopAndExit: @Sendable () -> Void = {
		Task {
			try? await stream.stopCapture()
			exit(0)
		}
	}

	signal(SIGTERM, SIG_IGN)
	signal(SIGINT, SIG_IGN)
	let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
	sigtermSource.setEventHandler(handler: stopAndExit)
	sigtermSource.resume()

	let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
	sigintSource.setEventHandler(handler: stopAndExit)
	sigintSource.resume()

	DispatchQueue.global(qos: .utility).async {
		while true {
			let data = FileHandle.standardInput.availableData
			if data.isEmpty {
				stopAndExit()
				break
			}
		}
	}

	while true {
		try await Task.sleep(nanoseconds: 1_000_000_000)
		if let pid = targetPid, !processExists(pid) {
			// Target process exited; keep stream alive (emits silence) just like Windows.
		}
	}
}

@main
struct MacOSAudioHelper {
	static func main() async {
		let args = Array(CommandLine.arguments.dropFirst())
		guard let command = args.first else {
			fputs("Usage: macos-audio-helper [--probe | --list-apps | --resolve-windows <ids> | --capture-system | --capture-pid <pid>]\n", stderr)
			exit(2)
		}

		do {
			switch command {
			case "--probe":
				let ver = ProcessInfo.processInfo.operatingSystemVersion
				let info = ProbeInfo(
					backend: "ScreenCaptureKit",
					macosVersion: "\(ver.majorVersion).\(ver.minorVersion).\(ver.patchVersion)",
					majorVersion: ver.majorVersion,
					arch: currentArch(),
					sampleRate: 48000,
					channels: 2,
					bitsPerSample: 16
				)
				let data = try JSONEncoder().encode(info)
				print(String(data: data, encoding: .utf8) ?? "{}")

			case "--list-apps":
				print(try await listAppsJson())

			case "--resolve-windows":
				let handles = args.count > 1 ? args[1] : ""
				print(try resolveWindowsJson(handles))

			case "--capture-system":
				try await runCapture(mode: "system", targetPid: nil)

			case "--capture-pid":
				guard args.count > 1, let pid = Int32(args[1]), pid > 0 else {
					fputs("Choose a valid application process.\n", stderr)
					exit(2)
				}
				try await runCapture(mode: "app", targetPid: pid)

			default:
				fputs("Unknown flag: \(command)\n", stderr)
				exit(2)
			}
		} catch {
			fputs("\(error.localizedDescription)\n", stderr)
			exit(1)
		}
	}
}

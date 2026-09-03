// Cut the player out of a photograph: the subject kept, everything behind them removed.
//
//   cutout <photo> <out.png> [--all] [--whole]
//
// This is the step before server/silhouette.mjs. That takes the shape from a cut-out's alpha and
// can't invent one, so something has to do the cutting — and the machine already knows how. This
// is the same Vision request behind "Remove Background" in Preview, which runs on the Mac, offline
// and free, and needs nothing installed.
//
// It is macOS-only by nature, which is why it is a tool run by hand rather than part of the
// server: the container is Linux, and putting this on the server would mean a segmentation model
// and its runtime riding along in the image. Cutting out happens here; the site takes it from
// there.
//
// Vision finds every foreground subject in the photo and this keeps the largest one — in a match
// photograph that is the player the picture is of, with the defender trailing them and the crowd
// behind left out. --all keeps every subject instead, for a photo where the one that matters
// isn't the biggest.

import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("cutout: \(message)\n".utf8))
    exit(1)
}

let arguments = CommandLine.arguments.dropFirst()
let flags = Set(arguments.filter { $0.hasPrefix("--") })
let paths = arguments.filter { !$0.hasPrefix("--") }
guard paths.count == 2 else {
    fail("usage: cutout <photo> <out.png> [--all] [--whole]")
}
let (input, output) = (paths[0], paths[1])

// Cropping to the subject is the default: the margin around them is empty pixels that would be
// carried through every upload and every silhouette for nothing.
let keepWholeFrame = flags.contains("--whole")
let keepEveryInstance = flags.contains("--all")

guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: input) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fail("could not read \(input) as an image")
}

let handler = VNImageRequestHandler(cgImage: image, options: [:])
let request = VNGenerateForegroundInstanceMaskRequest()
do {
    try handler.perform([request])
} catch {
    fail("Vision could not read this image: \(error.localizedDescription)")
}

guard let result = request.results?.first, !result.allInstances.isEmpty else {
    fail("no subject found in \(input) — nothing stands out from the background")
}

/// How many pixels an instance's mask covers, for picking the subject the photo is actually of.
func area(of instance: Int) -> Int {
    guard let mask = try? result.generateScaledMaskForImage(
        forInstances: IndexSet(integer: instance), from: handler,
    ) else { return 0 }

    CVPixelBufferLockBaseAddress(mask, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(mask) else { return 0 }

    let width = CVPixelBufferGetWidth(mask)
    let height = CVPixelBufferGetHeight(mask)
    let stride = CVPixelBufferGetBytesPerRow(mask)
    var covered = 0
    for y in 0..<height {
        let row = base.advanced(by: y * stride).assumingMemoryBound(to: Float.self)
        for x in 0..<width where row[x] > 0.5 { covered += 1 }
    }
    return covered
}

let instances: IndexSet
if keepEveryInstance || result.allInstances.count == 1 {
    instances = result.allInstances
} else {
    let biggest = result.allInstances.max { area(of: $0) < area(of: $1) }!
    instances = IndexSet(integer: biggest)
}

guard let masked = try? result.generateMaskedImage(
    ofInstances: instances, from: handler, croppedToInstancesExtent: !keepWholeFrame,
) else {
    fail("could not separate the subject from the background")
}

// PNG, and RGBA8 rather than the buffer's premultiplied form, because what reads this next is a
// plain PNG decoder that expects straight alpha.
let context = CIContext()
let cutout = CIImage(cvPixelBuffer: masked)
do {
    try context.writePNGRepresentation(
        of: cutout,
        to: URL(fileURLWithPath: output),
        format: .RGBA8,
        colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
    )
} catch {
    fail("could not write \(output): \(error.localizedDescription)")
}

let kept = keepEveryInstance ? result.allInstances.count : 1
print("\(output) \(Int(cutout.extent.width))x\(Int(cutout.extent.height)) " +
      "(\(kept) of \(result.allInstances.count) subjects)")

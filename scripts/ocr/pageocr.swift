// scripts/ocr/pageocr.swift (WP-OCR2)
// OCR ONE page of a PDF with Apple's Vision framework, fully local, and print JSON: every text
// observation Vision found with its box, so a reader can tell which row and which column a figure
// sits in. Derived from ~/life tracker/_meta/ocr/pdfocr.swift (the 21 Sep build that stays under
// 1 GB), with the same rendering and the same lock.
//
// Usage: pageocr <file.pdf> <page>      (page is 1-based, as Preview shows it)
// Output: {"engine":"apple-vision/accurate/no-lc/6x","page":N,"width":W,"height":H,
//          "observations":[{"text":"...","confidence":0.98,"box":[x0,y0,x1,y1]}, ...]}
// Boxes are fractions of the page, origin at the TOP left, so y grows down the page.
//
// One page per process, on purpose. On 21 Sep 2026 parallel runs of an older build reached
// 114 GB and the Mac killed everything. This tool cannot OCR two pages, and it takes the same
// /tmp/pdfocr.lock as pdfocr, so a second OCR process on this Mac waits for the first to exit.
//
// Build: swiftc -O scripts/ocr/pageocr.swift -o scripts/ocr/.build/pageocr   (from product/)
import Foundation
import PDFKit
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let pageNumber = Int(args[2]), pageNumber >= 1,
      let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else {
    FileHandle.standardError.write("usage: pageocr <file.pdf> <page>\n".data(using: .utf8)!)
    exit(2)
}
guard pageNumber <= doc.pageCount, let page = doc.page(at: pageNumber - 1) else {
    FileHandle.standardError.write("page \(pageNumber) out of range 1..\(doc.pageCount)\n".data(using: .utf8)!)
    exit(3)
}
let lockFD = open("/tmp/pdfocr.lock", O_CREAT | O_RDWR | O_EXLOCK, 0o644)
_ = lockFD

let bounds = page.bounds(for: .mediaBox)
let scale: CGFloat = 6.0
let width = Int(bounds.width * scale), height = Int(bounds.height * scale)
guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                          space: CGColorSpaceCreateDeviceRGB(),
                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { exit(4) }
ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
ctx.scaleBy(x: scale, y: scale)
page.draw(with: .mediaBox, to: ctx)
guard let cg = ctx.makeImage() else { exit(4) }

let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false             // numbers must not be "corrected"
try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])

var observations: [[String: Any]] = []
for o in req.results ?? [] {
    guard let c = o.topCandidates(1).first else { continue }
    let b = o.boundingBox                        // Vision: origin bottom left
    let r = { (v: CGFloat) in (Double(v) * 10000).rounded() / 10000 }
    observations.append([
        "text": c.string,
        "confidence": (Double(c.confidence) * 1000).rounded() / 1000,
        "box": [r(b.minX), r(1 - b.maxY), r(b.maxX), r(1 - b.minY)],
    ])
}
let out: [String: Any] = [
    "engine": "apple-vision/accurate/no-lc/6x",
    "page": pageNumber,
    "width": Int(bounds.width),
    "height": Int(bounds.height),
    "observations": observations,
]
let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)

// 위치 QR 자산을 건물 자료에서 다시 만들거나(make), 만든 자산의 내용을 읽어 대조한다(check).
//   swift web/scripts/location-qr.swift make  data/space/wfi-v1.json web/public/qr
//   swift web/scripts/location-qr.swift check data/space/wfi-v1.json web/public/qr
// 내용은 SAFEROUTE:<building_id>:<building_version>:<node_id>다. 건물 자료 버전을 올리면 다시 만든다.
// macOS Core Image의 CIQRCodeGenerator(M 오류 정정, 6배 크기, 4모듈 여백)를 쓴다.
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 4, ["make", "check"].contains(args[1]) else { print("usage: location-qr.swift make|check <building.json> <dir>"); exit(2) }
let json = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[2]))) as! [String: Any]
let building = json["building_id"] as! String
let version = json["building_version"] as! Int
let signs = json["signs"] as! [[String: Any]]
let context = CIContext()
var bad = 0
for sign in signs {
  let id = sign["sign_id"] as! String
  let text = "SAFEROUTE:\(building):\(version):\(sign["node_id"] as! String)"
  let url = URL(fileURLWithPath: args[3]).appendingPathComponent("\(id).png")
  if args[1] == "make" {
    let filter = CIFilter(name: "CIQRCodeGenerator")!
    filter.setValue(text.data(using: .utf8), forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    let code = filter.outputImage!.transformed(by: CGAffineTransform(scaleX: 6, y: 6))
    // 생성기 출력 둘레에 흰 바탕 4모듈(24px)을 두른다. 버전 5 자산과 같은 크기(210px)다.
    let frame = code.extent.insetBy(dx: -24, dy: -24)
    let white = CIImage(color: .white).cropped(to: frame)
    let image = context.createCGImage(code.composited(over: white), from: frame)!
    let out = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(out, image, nil)
    if !CGImageDestinationFinalize(out) { print("쓰기 실패 \(id)"); bad += 1 }
  } else {
    let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: context, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
    let read = CIImage(contentsOf: url).flatMap { detector.features(in: $0).compactMap { ($0 as? CIQRCodeFeature)?.messageString }.first }
    if read != text { print("불일치 \(id): \(read ?? "읽지 못함") ≠ \(text)"); bad += 1 }
  }
}
print("\(args[1]) \(signs.count - bad)/\(signs.count)")
exit(bad == 0 ? 0 : 1)

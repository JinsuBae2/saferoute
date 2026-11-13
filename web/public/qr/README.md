# WFI v6 위치 QR

유도등 43개의 `sign_id.png` 정적 이미지다. 내용은 `SAFEROUTE:WFI:6:<node_id>`(건물 ID · 자료 버전 · 지점)이며 실행·체험방·인증 정보는 포함하지 않는다. macOS Core Image의 CIQRCodeGenerator(M 오류 정정, 6배 크기, 4모듈 여백)로 생성했다.

현재 휴대폰 화면은 같은 층의 가까운 이동 지점으로 QR 인식 연출을 제공한다. 실제 카메라 디코딩이나 외부 휴대폰 앱 연결은 구현하지 않았다. 공간 자료 버전이 바뀌면 해당 지점의 QR을 다시 생성해야 한다.

다시 만들기와 대조(macOS):

```bash
swift web/scripts/location-qr.swift make data/space/wfi-v1.json web/public/qr
swift web/scripts/location-qr.swift check data/space/wfi-v1.json web/public/qr
```

`check`는 각 이미지를 실제로 읽어 건물 자료의 ID·버전·지점과 같은지 본다. 버전이 다른 예전 QR은 불일치로 나온다. 화면의 QR 연출은 건물 ID와 자료 버전이 이 자산과 같을 때만 켜진다(`web/src/building/phoneGuide.ts`).

# A06-1 CCTV 미리보기 계약·인계

관련: [#91](https://github.com/JinsuBae2/saferoute/issues/91), 상위 [#73](https://github.com/JinsuBae2/saferoute/issues/73), 화면 담당 [#74](https://github.com/JinsuBae2/saferoute/issues/74).

이 단계는 표시용 `Preview` DTO·수락/거부 샘플·생성 TypeScript만 제공한다. **조회 API·JPEG 송출·AI worker 연결은 아직 구현하지 않았다.** 아래 URL과 전송 규칙은 #73의 구현 기준이며 지금 실행 가능한 엔드포인트가 아니다. 기존 `ObservationEvent`·`StateSnapshot`·설명·명령/ACK 계약은 바꾸지 않는다.

## 데이터 형식

Python은 `backend/contracts/previews.py`, 공통 파서는 `parse_contract("Preview", payload)`, TypeScript는 `contracts/types.generated.ts`의 `Preview`다. 검증 샘플은 `data/contracts/valid.json`의 `preview_*` 6개와 `rejected.json`의 `preview-*` 24개다. 가상 시각·합성 상자이며 실제 추론·영상·성능 증거가 아니다.

| 필드 | 의미 |
| --- | --- |
| schema_version, run_id, building_id, building_version | 기존 실행·건물 식별자 형식. 현재 제어 세션과 비교 |
| source_id | 등록된 VIDEO_AI 관측원. 설치 위치는 M04, 관측 구역은 기존 Building의 source→zone 매핑 |
| generated_at | 응답 생성 시점의 서버 UTC. 프레임 취득 시각을 대신하지 않음 |
| freshness_ms | 해당 관측원 설정과 동일한 유효기간. 클라이언트가 임의로 늘리지 않음 |
| status | INITIALIZING / READY / STALE / EOF / UNAVAILABLE |
| frame | READY에서만 PreviewFrame, 나머지는 반드시 null |
| error_code | UNAVAILABLE에서만 VIDEO_OPEN_FAILED / DECODE_FAILED / INFERENCE_FAILED / DELIVERY_FAILED / PREVIEW_FAILED / OPERATOR_STOPPED, 나머지는 null |

PreviewFrame은 `frame_id`(각 분석 프레임의 새 UUID), `frame_index`(디코딩 원본 기준 0부터), `media_time_ms`(영상 상대 시각), `observed_at`(실제 취득 UTC), `inference_completed_at`, `expires_at`, 원본 `width/height`, `detections`를 포함한다. 샘플링으로 frame_index가 건너뛸 수 있으며 다른 실행/영상의 같은 번호를 같은 프레임으로 취급하지 않는다. 프레임 ID는 재사용하지 않는다.

`observed_at <= inference_completed_at <= generated_at < expires_at`이고 `expires_at - observed_at <= freshness_ms`여야 한다. 추론·인코딩·조회·재접속으로 유효기간을 새로 시작하지 않는다. 검출 배열이 빈 READY는 해당 프레임의 모델 검출 없음이며 물리적 안전이나 제어 NORMAL을 뜻하지 않는다.

## 검출 좌표

각 검출은 `hazard_type: FIRE | SMOKE`, `confidence: 0..1`, `xyxy: [x1,y1,x2,y2]`다. 좌표는 **추론에 넣은 원본 프레임의 좌상단을 (0,0), 우하단 경계를 (1,1)로 정규화**한다. 유한한 수·원소 4개·0..1 범위·양의 너비와 높이를 검사한다. confidence는 모델 점수이며 화재 확률이나 경보 확정값이 아니다.

worker의 현재 `Detector.predict`는 원본 픽셀 xyxy를 반환한다. 후속 어댑터에서 원본 너비/높이로 각각 나누며, 모델 입력의 letterbox/640 크기를 분모로 쓰지 않는다. 원본 범위 밖의 상자는 원본 경계로 자른 뒤 면적이 0이면 제외한다. 원본 로그는 보존한다. 이미지와 상자를 서로 다른 프레임에서 조합하지 않는다.

샘플 FIRE `[0.25,0.25,0.5,0.75]`의 원본 1280×720 좌표는 `[320,180,640,540]`이다. 이미지 내용이 640×360으로 표시되면 `[160,90,320,270]`이다. `object-fit: contain` 여백이 있으면 실제 이미지 내용 영역의 시작 오프셋을 더한다. 크롭·회전·좌우 반전은 하지 않으며 JPEG가 축소되어도 원본과 종횡비·방향이 같아야 한다. 실제 영상·JPEG 대조는 #73 후속이다.

## 예정 조회·이미지 결합 규칙

로컬·SSH 터널 범위의 별도 미리보기 서비스로 계획한다. 제어 API의 요청 처리 안에서 이미지 생성·전송을 기다리지 않는다. 영상 접근 권한을 넓히거나 공개 서비스를 추가하지 않는다.

- 메타데이터: `GET /api/previews/{source_id}?run_id=<현재 실행 UUID>` → 알려진 상태 200/Preview. 모든 응답은 `Cache-Control: no-store`.
- 이미지: `GET /api/preview-frames/{frame_id}.jpg?run_id=<현재 실행 UUID>&source_id=<선택한 관측원>` → 동일 분석 프레임의 JPEG. 응답 `X-Preview-Frame-Id`가 요청 frame_id와 같아야 한다. ID는 URL 인코딩한다.
- 이전 실행은 409, 미등록 카메라는 404, 현재 세션 확인 실패는 503이다. 메타데이터를 받은 뒤 해당 이미지가 교체·만료·폐기되었으면 404로 응답하며 새 프레임 이미지로 대신 채우지 않는다. HTTP 오류의 JSON 형식은 기존 ErrorResponse를 사용한다.
- 조회 서버는 알려진 현재 세션만 내보낸다. worker 종료·읽기 실패는 각각 EOF/UNAVAILABLE, 후속 프레임이 제때 도착하지 않으면 STALE이다. 새 세션·카메라의 첫 유효 프레임 전에는 INITIALIZING이다. 연결 실패 자체는 클라이언트의 조회 실패이며 READY를 유지할 근거가 아니다.
- 오류 세부 로그는 기존 worker에 남긴다. 세부 원인의 외부 상태 매핑은 후속 구현에서 시험한다. EOF/STALE/UNAVAILABLE가 제어기의 활성 경보를 해제하거나 관측 유효기간을 연장하지 않는다.

화면 연결 순서는 다음과 같다.

1. 현재 `/api/state`의 실행·건물 버전과 선택한 source_id로 조회한다. 응답 식별자를 다시 대조하고 Building에 등록된 VIDEO_AI인지 확인한다. DTO 구조 통과만으로 이 동적 일치가 확인되지는 않는다.
2. READY만 이미지 조회를 시작한다. 메타데이터와 이미지 모두 받은 시점에 실행·카메라 선택·프레임 ID가 여전히 같은지 다시 확인한다. 선택 변경/reset 시 진행 요청을 취소하고 기존 이미지와 상자를 같이 지운다. 지난 비동기 응답은 표시하지 않는다.
3. 서버 generated_at과 로컬 요청/응답의 monotonic 왕복 시간을 사용해 남은 시간을 보수적으로 계산한다. `expires_at - generated_at - 전체 요청 왕복시간`이 0 이하면 버린다. 이미지 다운로드 시간도 같은 기한에서 차감한다. PC의 벽시계 차이로 TTL을 늘리지 않는다.
4. 만료 시 타이머로 이미지와 상자를 같이 지운다. STALE/EOF/UNAVAILABLE·HTTP 실패·현재 제어 세션 확인 실패 시 즉시 지운다. 과거 이미지 보관 화면은 이번 범위가 아니다.

## 남은 구현과 검증

후속 #73은 용량이 제한된 최신 프레임 전달, 인코딩/느린 수신/포트 오류가 관측 전송을 막지 않는 격리, 실제 정상·불꽃·연기·EOF·읽기 실패, reset·카메라 전환·지연 시 이전 이미지 차단을 구현하고 측정해야 한다. 이번 형식 검사는 그 동작을 증명하지 않는다. #74는 계약을 이용한 화면 연결을 담당하며 기존 제어 상태·경로 판단은 그대로 사용한다.

검사: `python -m pytest tests/test_preview_contract.py tests/test_contract.py tests/test_contract_exports.py -q`, `python -m tools.export_contracts --check`, `npm run test:contracts`. TypeScript는 생성된 정적 형식이며 범위/상태/수명·현재 실행 확인은 실행 시 검사가 필요하다. 새 모델·영상·평가 설정·Bedrock 호출을 추가하지 않았다.

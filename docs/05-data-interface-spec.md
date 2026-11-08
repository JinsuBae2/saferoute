# saferoute 데이터·인터페이스 명세서

[기획서](01-project-proposal.md) · [개발계획서](02-development-plan.md) · [상세설계](04-system-design.md)

이 문서는 공간 데이터, 관측 이벤트, 경로 결과, 유도등 명령과 응답의 **공통 기준안 v1**이다. 현재 구현된 API의 설명이 아니라 팀이 구현하고 계약 시험으로 확인할 규칙이다. 필드·열거값·오류를 변경할 때 이 문서, Python 검증 모델, TypeScript 형식, 시험 자료를 함께 수정한다. 데이터 원본 책임자는 2번이며 공간 자료는 4번이 작성·검수한다.

## 1. 공통 규칙

| 항목 | 규칙 |
| --- | --- |
| JSON | UTF-8. 키는 snake_case. 정의하지 않은 입력 필드는 거부 |
| 식별자 | 문자열. 화면 라벨과 별개이며 이름 변경 때문에 ID를 재사용하지 않음 |
| schema_version | 정수 1. 지원하지 않는 버전은 거부 |
| building_id / building_version | 건물 식별자 / 정수 자료 버전. 공간·시나리오·명령에서 일치 |
| run_id | 제어기 시작·명시적 초기화 때 생성하는 UUID. 이전 실행 입력·명령 거부 |
| event_id | 입력 공급자가 생성하는 UUID. 재전송 시 같은 값을 유지 |
| source_sequence | 실행·관측원별 단조 증가 정수. 중복·역순 입력 판정 |
| guidance_version | 실행 안에서 안내 판단이 바뀔 때 증가. 시간 흐름만으로 증가시키지 않음 |
| command_sequence | 실행·유도등별 명령 발행 순번. 동일 안내의 유효기간 갱신에도 증가 |
| 시각 | 기록용 UTC ISO 8601, 지속시간 ms, 서버 내부 만료·측정은 monotonic clock |
| 경로 단위 | 상대 모델 좌표·양수 비용. 실측 거리나 이동시간이라는 뜻이 아님 |
| nullable | 명시적으로 허용한 필드만 null 사용. 빈 문자열로 미정을 대신하지 않음 |

입력 생산자와 제어기는 기본 배포에서 같은 서버에 둔다. 영상 재생 시각은 `media_time_ms`로 따로 기록하고 현재 UTC와 혼동하지 않는다. 다른 PC에서 직접 관측을 보내는 구성을 추가하려면 시계 차이·허용 오차를 검증한 뒤 사용한다. 서로 다른 PC의 monotonic 값을 빼서 지연을 계산하지 않는다.

## 2. 공간 자료

### 2.1 최상위 구조

| 필드 | 형식 | 내용 |
| --- | --- | --- |
| schema_version | integer | 1 |
| building_id | string | 예: WFI |
| building_version | integer | 구조·배치 변경 시 증가 |
| coordinate_system | object | 축·단위·원점·층 높이의 가정 |
| floors | array | floor_id, label, elevation |
| zones | array | zone_id, floor_id, label, polygon, blocked_node_ids, blocked_edge_ids |
| nodes | array | node_id, floor_id, zone_id, position, kind |
| edges | array | edge_id, from_node_id, to_node_id, kind, cost, traversable, door_open |
| exits | array | exit_id, node_id, enabled, assumption |
| sources | array | source_id, source_type, zone_id, required, freshness_ms |
| signs | array | sign_id, node_id, faces |
| assumptions | array | 항목·근거·가정 내용·검토자 |
| provenance | object | 안내도 URL·확인일·자료 작성자 |

`position`은 `{ "x": 0, "y": 0, "z": 0 }`이며 y가 높이다. 평면도 가로축은 +x, 위쪽은 -z로 맞춘다. 층별 이미지 원점·축척·평행이동은 `coordinate_system`에 기록한다. 단위는 모델용 m로 표시하되 실측하지 않았다면 `measured: false`를 둔다.

`polygon`은 해당 층 평면의 `{ "x": number, "z": number }` 점 3개 이상으로 이루어진 배열이다. 모든 좌표·cost는 유한한 수여야 한다. node.kind는 JUNCTION·DOOR·STAIR·EXIT 중 하나다. 동일 층 연결을 원칙으로 하되 계단 edge만 층간 노드를 연결한다. 반복점·자기 교차·좌표 범위 오류는 공간 검수에서 확인한다. zone의 차단 목록은 그래프 ID를 참조하며 연기 모양의 크기로 자동 추론하지 않는다.

통로는 **방향이 있는 edge**다. edge.kind는 CORRIDOR·DOOR·STAIR 중 하나다. 양방향 이동은 반대 방향 edge를 각각 등록한다. 계단은 실제로 연결된 두 층의 노드를 잇고 복도와 구분한다. traversable은 boolean이고 door_open은 DOOR에서 boolean, 그 외 null이다. 문이 닫혀도 `traversable: true`일 수 있다. 문 개방 상태만으로 경로에서 제거하지 않는다.

### 2.2 관측원과 유도등

관측원 유형은 `VIDEO_AI`, `SIM_SMOKE_DETECTOR`, `SIM_SPRINKLER`, `MANUAL_TEST`다. 유형은 설정에서 고정하고 이벤트가 다른 유형으로 가장하면 거부한다. 영상 전체를 한 구역에 매핑하는 기본안에서 픽셀 좌표를 실제 건물 발화 좌표라고 표현하지 않는다.

`required`인 관측원이 유효하지 않으면 해당 관측 구역의 설정된 차단 대상을 화재 경로 후보에서 제외한다. 범위가 넓다는 이유로 임의의 모든 층을 차단하지 않는다. 겹치는 관측원 중 하나가 정상이어도 다른 필수 관측원의 불확실성이 자동 해소되지 않는다.

유도등 예시 조각:

```json
{
  "sign_id": "SIGN-S",
  "node_id": "S",
  "faces": [
    {
      "face_id": "FRONT",
      "view_direction": {"x": 0, "y": 0, "z": -1},
      "default_next_node_id": "A",
      "next_node_to_display": {"A": "LEFT", "B": "RIGHT"}
    }
  ]
}
```

`next_node_to_display`는 표시면을 바라보는 사람 기준이다. 반대편 표시면은 별도의 `face_id`와 매핑을 가진다. 허용 표시값은 `LEFT`, `RIGHT`, `FORWARD`, `BACK`, `STAIRS_UP`, `STAIRS_DOWN`, `EXIT`다. 계단의 오르내림은 평면상의 좌우와 혼동하지 않는다. 매핑되지 않은 다음 지점은 임의 회전으로 표시하지 않고 `UNSUPPORTED_DISPLAY`로 안내 불가 처리한다.

## 3. 관측 이벤트

### 3.1 입력 예시

`POST /api/events`:

```json
{
  "schema_version": 1,
  "run_id": "11111111-1111-4111-8111-111111111111",
  "building_id": "TWO_ROUTE",
  "building_version": 1,
  "event_id": "22222222-2222-4222-8222-222222222222",
  "source_id": "CAM-A",
  "source_type": "VIDEO_AI",
  "source_sequence": 17,
  "event_kind": "ALARM",
  "hazard_type": "FIRE",
  "validity": "VALID",
  "observed_at": "2026-11-10T01:00:00.000Z",
  "media_time_ms": 4200,
  "confidence": 0.82,
  "reason_code": null
}
```

UUID·시각·신뢰도는 자료형 예시이며 실제 시험 결과가 아니다. `zone_id`는 관측원 설정에서 서버가 결정한다. 이벤트가 임의 구역을 지정해 관측 범위를 바꾸지 못하게 한다. 영상의 구역 매핑 변경은 설정 변경과 새 실행으로 적용한다.

### 3.2 필드와 유효성

| 필드 | 형식·범위 | 규칙 |
| --- | --- | --- |
| event_kind | OBSERVATION / ALARM / HEARTBEAT / UNAVAILABLE | 아래 의미에 따라 처리 |
| hazard_type | FIRE / SMOKE / SPRINKLER / null | ALARM은 필수, 나머지는 null |
| validity | VALID / UNAVAILABLE | ALARM·OBSERVATION·HEARTBEAT은 VALID, UNAVAILABLE 이벤트는 UNAVAILABLE |
| observed_at | UTC 시각 | 영상 프레임 획득 또는 설비 관측 발생 시각. 추론 완료·서버 수신 시각과 분리 |
| media_time_ms | 0 이상 integer / null | VIDEO_AI의 실제 영상 위치, 그 외 null |
| confidence | 0~1 number / null | VIDEO_AI ALARM에서 필수. 센서 이벤트에서는 null |
| reason_code | string / null | 관측 불가이면 EOF, DECODE_FAILED, OCCLUDED, SOURCE_DOWN 등 |
| source_sequence | 1 이상 integer | 같은 실행·관측원 안에서 증가 |

- `OBSERVATION`: 프레임 분석이 정상 완료되었으나 지속 경보 조건은 충족하지 않음. 관측 신선도 갱신, 기존 경보 유지.
- `ALARM`: 해당 원인의 경보 활성화. 영상 작업자가 합의한 신뢰도·지속 조건을 통과했거나 가상 설비가 동작.
- `HEARTBEAT`: 프로세스·장치의 생존 확인. 영상의 새 프레임 분석을 대신하지 않음. 가상 설비는 설정된 주기의 상태 확인으로 활용.
- `UNAVAILABLE`: 관측 불가. 경보 해제가 아니며 기존 활성 원인은 유지.

영상의 가림 판정을 실제로 구현하지 않았다면 `OCCLUDED`를 자동 감지했다고 주장하지 않는다. 시험 주입 또는 어댑터가 실제 제공하는 상태로 구분한다.

VIDEO_AI는 FIRE·SMOKE, SIM_SMOKE_DETECTOR는 SMOKE, SIM_SPRINKLER는 SPRINKLER 경보만 허용한다. MANUAL_TEST는 설정에서 허용한 종류만 보낼 수 있다. 영상 추론 완료 시각·처리 지연은 AI 상세 로그에 별도 저장한다. 오래 걸린 추론의 observed_at을 완료 시각으로 바꿔 최신 프레임처럼 취급하지 않는다.

### 3.3 수신 규칙

1. schema·필드·ID·건물 버전·실행 ID·관측원 유형을 검증한다.
2. 동일 `event_id`와 동일 내용이면 중복으로 응답하고 상태는 재적용하지 않는다. 같은 ID에 다른 내용이면 충돌로 거부한다.
3. 더 낮거나 같은 source_sequence의 새 이벤트는 역순으로 거부한다.
4. 같은 서버 시계 기준으로 미래 시각·허용 신선도보다 오래된 입력을 거부하고 이유를 기록한다. 수신 지연으로 관측 유효기간을 새로 전부 부여하지 않는다.
5. 경보 원인과 관측 유효성을 갱신한다. 상태 변경·시간 만료 작업을 하나의 직렬 처리 영역에서 실행한다.
6. 판단에 영향을 주면 경로·유도등 결과를 한 번에 생성하고 새 guidance_version으로 게시한다.
7. 입력 응답과 로그를 남긴다.

응답은 `{ "accepted": true, "duplicate": false, "event_id": "...", "run_id": "...", "guidance_version": 3 }` 형식이다. 수락은 단말 적용 성공을 의미하지 않는다.

## 4. 경보 상태와 안내 결과

경보 키는 `(source_id, hazard_type)`다. 각 항목에 활성 여부, 최초·최종 근거 이벤트, 활성 시각과 해제 기록을 둔다. 관측원별 유효성은 별도 상태로 저장한다.

| 상황 | 활성 경보 | 관측 유효성 |
| --- | --- | --- |
| 새 경보 | 해당 원인 활성 | 유효 입력이면 VALID |
| 정상 미검출 | 유지 | 새 분석이면 갱신 |
| 영상 종료·끊김 | 유지 | UNAVAILABLE 또는 STALE |
| 다른 센서의 정상 상태 | 유지 | 그 센서 상태만 갱신 |
| 특정 원인 확인 해제 | 지정한 원인만 비활성 | 신선도와 별도 |
| 실행 초기화·서버 재시작 | 새 실행, 이전 로그 보존 | INITIALIZING으로 시작 |

제어 상태는 `INITIALIZING`, `NORMAL`, `EMERGENCY`, `DEGRADED`다. 새 실행은 자동으로 평상시 화살표를 내보내지 않는다. 명시적 시작 승인과 필요한 관측 확인 후 정상 또는 경보 상태로 전환한다. 이는 **시연 실행 시작 절차**이며 실제 수신반 복구 정책을 의미하지 않는다.

안내 스냅샷은 run_id, building_id, building_version, guidance_version, controller_mode, 위험 원인 목록, 차단 노드·통로와 사유, node별 다음 지점·출구·경로, sign별 표시 결과를 담는다. 한 응답 안에서 서로 다른 안내 버전을 섞지 않는다.

안내 불가 이유:

| 코드 | 의미 |
| --- | --- |
| INITIALIZING | 새 실행 준비 중 |
| ORIGIN_BLOCKED | 출발 지점 자체가 위험·차단됨 |
| NO_REACHABLE_EXIT | 남은 연결에서 출구에 도달 불가 |
| REQUIRED_OBSERVATION_UNKNOWN | 필수 관측이 유효하지 않아 후보 제외 |
| EXIT_UNAVAILABLE | 출구 조건 미충족 |
| UNSUPPORTED_DISPLAY | 해당 표시면에서 다음 지점 표시 불가 |
| CONTROLLER_UNAVAILABLE | 제어 상태 확인 불가 |
| COMMAND_EXPIRED | 단말이 가진 명령 유효기간 종료 |
| VERSION_MISMATCH | 실행·건물·안내 데이터 불일치 |

여러 원인이 있으면 reason_codes 배열로 제공한다. 안내 불가는 해당 지점이 안전하다거나 그 자리에 머물라는 지시가 아니다.

## 5. 유도등 명령과 적용 응답

### 5.1 명령 예시

`GET /api/signs/SIGN-S/command`:

```json
{
  "schema_version": 1,
  "run_id": "11111111-1111-4111-8111-111111111111",
  "building_id": "TWO_ROUTE",
  "building_version": 1,
  "guidance_version": 3,
  "sign_id": "SIGN-S",
  "command_id": "33333333-3333-4333-8333-333333333333",
  "command_sequence": 19,
  "issued_at": "2026-11-10T01:00:00.200Z",
  "valid_for_ms": 3000,
  "faces": [
    {
      "face_id": "FRONT",
      "mode": "DYNAMIC",
      "display": "RIGHT",
      "next_node_id": "B",
      "exit_id": "EXIT-Y",
      "reason_codes": []
    }
  ]
}
```

face의 mode는 `DEFAULT`, `DYNAMIC`, `NO_ROUTE`, `UNKNOWN`이다. DEFAULT도 확인된 정상 조건에서만 제공한다. NO_ROUTE·UNKNOWN에서는 display·next_node_id·exit_id가 null이며 reason_codes가 비어 있으면 안 된다.

### 5.2 단말 적용 순서

1. URL의 sign_id를 확인하고 `/api/session`에서 현재 실행·건물 버전을 읽는다.
2. 명령 조회는 한 번에 하나만 진행한다. 요청 시작 시 브라우저 monotonic 시각을 기록한다.
3. sign_id·run_id·building_version·sequence를 확인한다. 낮은 순번, 지난 실행, 다른 단말 명령은 적용하지 않는다.
4. 유효 기한은 **요청 시작 시각 + valid_for_ms**로 보수적으로 계산한다. 네트워크에서 지연된 시간을 다시 유효기간으로 더하지 않는다.
5. face 전체를 한 상태 갱신으로 반영한다. UI 반영 완료 후 적용 응답을 보낸다.
6. 기한 내 새 명령이 없으면 이전 화살표를 제거하고 UNKNOWN·COMMAND_EXPIRED로 전환한다.
7. 서버 실행이 바뀌면 기존 명령을 폐기하고 session을 다시 읽은 뒤 새 명령을 받는다.

서버는 guidance_version이 같아도 매 조회에 새로운 command_sequence·command_id를 발행한다. 동일한 방향을 유지하면서 유효기간을 갱신할 수 있다. 늦은 동일 버전 응답도 순번으로 배제한다.

브라우저 백그라운드·절전에서는 타이머가 지연될 수 있다. visibilitychange·복귀 시 먼저 만료를 확인하고 신선한 명령 전까지 방향을 표시하지 않는다. 브라우저 기반 시험으로 실제 등기구의 정확한 시간 보장이나 전기적 고장 동작을 입증하지 않는다.

### 5.3 적용 응답

`POST /api/signs/SIGN-S/ack`:

```json
{
  "schema_version": 1,
  "run_id": "11111111-1111-4111-8111-111111111111",
  "sign_id": "SIGN-S",
  "terminal_instance_id": "44444444-4444-4444-8444-444444444444",
  "command_id": "33333333-3333-4333-8333-333333333333",
  "command_sequence": 19,
  "guidance_version": 3,
  "status": "APPLIED",
  "faces": [{"face_id": "FRONT", "mode": "DYNAMIC", "display": "RIGHT"}],
  "client_apply_duration_ms": 8,
  "error_code": null
}
```

status는 APPLIED 또는 REJECTED다. 서버는 발행한 명령과 sign_id·run_id·버전·face 결과를 대조한다. 모르는 명령, 만료 명령, 내용이 다른 APPLIED는 적용 성공으로 계산하지 않는다. 응답의 클라이언트 시간은 참고값이며 서버 측 지연 측정과 구분한다.

HTTP 수신 성공만으로 APPLIED를 보내지 않는다. 브라우저 상태 반영은 소프트웨어 적용 증거이며 실제 화면은 별도 관찰로 확인한다. 최신 명령이 미적용이면 예전 ACK가 늦게 도착해도 최신 적용 상태를 성공으로 바꾸지 않는다. 동일 sign_id의 여러 브라우저 인스턴스는 중복 단말로 표시하고 두 개의 유도등으로 세지 않는다.

## 6. API 목록

| 메서드·경로 | 요청 | 성공 응답·용도 |
| --- | --- | --- |
| GET /api/health | 없음 | 서비스 생존. 모든 기능 정상이라는 뜻은 아님 |
| GET /api/session | 없음 | run_id, 건물 버전, controller_mode, schema_version |
| GET /api/building | 없음 | 현재 실행이 사용하는 검증된 공간 자료 |
| GET /api/state | 없음 | 하나의 안내 버전으로 묶인 상태·경로·단말 적용 현황 |
| POST /api/events | 3절 이벤트 | 수락·중복 여부와 해당 판단 버전 |
| GET /api/signs/{sign_id}/command | 없음 | 단말별 새 명령 |
| POST /api/signs/{sign_id}/ack | 5절 응답 | 응답 접수. 검증 실패 시 오류 |
| POST /api/control/arm | run_id, reason | 초기 관측 확인 후 시연 시작 허용 |
| POST /api/control/clear | run_id, source_id, hazard_type, reason | 특정 원인 확인 해제. 원인 없으면 명시 오류 |
| POST /api/control/reset | run_id, reason | 기존 실행 종료·새 run_id 생성·INITIALIZING |
| GET /sim/state | 없음 | 별도 시나리오 서버의 현재 정답·진행 시각·출처 |
| GET /sim/health | 없음 | 별도 시나리오 서버의 생존·진행 상태 |

`/sim` API는 8001의 시나리오 실행기가 제공한다. 제어기 코드가 이 API를 호출하거나 시나리오 정답 파일을 읽으면 안 된다. 건물·설비 설정은 공유할 수 있지만 정답 위험·미래 변화·기대 경로는 제어 입력이 아니다.

제어 요청 arm·clear·reset은 표의 필드 외에 schema_version=1을 포함한다. reason은 비어 있지 않은 문자열이다. 정상 처리의 HTTP 상태는 200으로 통일한다. arm은 `{ "run_id": "...", "controller_mode": "NORMAL", "armed": true }`, clear는 `{ "run_id": "...", "source_id": "...", "hazard_type": "SMOKE", "cleared": true, "guidance_version": 4 }`, reset은 `{ "previous_run_id": "...", "run_id": "...", "controller_mode": "INITIALIZING" }`를 반환한다. arm 당시 활성 경보가 있으면 controller_mode는 EMERGENCY다.

`/api/state`의 최상위 필드는 schema_version, run_id, building_id, building_version, guidance_version, generated_at, controller_mode, sources, active_causes, blocked_nodes, blocked_edges, routes, signs다. routes는 node_id, next_node_id, exit_id, path_node_ids, cost, reason_codes를 가진 객체 배열이다. 안내 불가이면 next_node_id·exit_id·cost는 null, path_node_ids는 빈 배열이다. signs는 sign_id, 최신 command_id·sequence·guidance_version, 적용 상태와 terminal_instance_id별 마지막 ACK를 포함한다.

조회 응답은 `Cache-Control: no-store`로 제공한다. 클라이언트도 캐시를 사용하지 않는다. POST 제어 기능은 기본 배포에서 SSH 접속 권한이 있는 팀원만 접근하는 내부 경로다. 공개 배포가 결정되면 인증·권한을 먼저 구현하고 무인증 reset·clear·event 전송을 열지 않는다.

### 6.1 오류

공통 오류 형식은 `{ "error": { "code": "RUN_MISMATCH", "message": "실행이 변경되었습니다", "field": "run_id" } }`다. FastAPI 기본 검증 오류도 이 형식으로 정규화한다.

| HTTP | 예 | 처리 |
| --- | --- | --- |
| 400 | INVALID_EVENT_COMBINATION | 의미상 허용하지 않는 조합 |
| 404 | UNKNOWN_SOURCE / UNKNOWN_SIGN | 등록되지 않은 ID |
| 409 | RUN_MISMATCH / BUILDING_MISMATCH / STALE_SEQUENCE / EVENT_ID_CONFLICT | 실행·버전 재확인. 기존 이벤트를 새 실행으로 바꿔 자동 재전송 금지 |
| 409 | STALE_OBSERVATION / CLOCK_INVALID / SOURCE_CAUSE_INACTIVE | 오래된 관측·허용하지 않는 미래 시각·비활성 원인 해제 |
| 422 | SCHEMA_VALIDATION_FAILED | 필수 필드·자료형 오류 |
| 503 | CONTROLLER_NOT_READY | 새 명령 제공 불가. 클라이언트는 만료 정책 유지 |

네트워크 재시도는 같은 event_id·sequence로 제한한다. 오래된 경보를 몇 분 뒤 정상 신규 관측처럼 제출하지 않는다. 공급자가 재시작해 순번을 잊었으면 시연을 명시적으로 새 실행으로 시작한다.

## 7. 시나리오 형식

시나리오는 schema_version, scenario_id, building_id, building_version, seed, duration_ms, start_trigger, initial_observations, smoke_timeline, observation_rules, faults를 가진다. 기본 start_trigger는 ARM이다.

- `smoke_timeline`: 시간·구역·0~1 표현 강도. 실제 농도·물리 예측값이 아님.
- `observation_rules`: 가상 관측원, 임계값, 관측 주기, 지연. 정답에서 이벤트를 만드는 시험 장치의 규칙.
- `faults`: 특정 관측 누락·프로세스 단절·전송 지연 등의 구간.
- `initial_observations`: 초기 필수 관측 확인. 모든 구역을 무조건 정상이라고 간주하지 않음.
- `seed`: 난수를 쓸 때만 의미가 있으며 반복 시험에서 고정.
- 시나리오 실행기는 시작 시 현재 run_id를 읽고 고정한다. 실행 도중 run_id가 바뀌면 전송을 중단한다.
- arm 전에는 초기 관측·상태 확인만 전달하고 주요 시간표는 대기한다. arm 확인을 시나리오 t=0으로 한다. 실제 AI 경보를 시작 조건으로 쓰는 기능은 별도 설정·시험 후 추가한다.

`/sim/state`는 scenario_id, run_id, building_version, simulation_time_ms, simulation_sequence, running/completed/failed 상태와 현재 구역별 smoke 값만 제공한다. 관제는 연기 정답과 제어기 관측을 별도 범례로 표시한다. 미래 정답은 화면에도 필요 이상 보내지 않는다.

## 8. 저장·감사 로그

| 파일 | 기록 |
| --- | --- |
| manifest.json | run_id, 코드 commit, 설정·건물·모델 해시, OS·장비, 시작·종료, 시나리오·평가 모드 |
| events.jsonl | 수신·거부·중복 입력, 수신 UTC·서버 monotonic, 거부 이유 |
| decisions.jsonl | 원인 이벤트 또는 만료, 전후 상태, 차단 대상, 안내 버전, 계산 시간 |
| commands.jsonl | 명령 ID·순번·대상·안내 버전·발행 시각·기한 |
| acks.jsonl | 수신·검증 결과, 적용 여부, 서버 수신 시각 |
| verification.json | 시험 ID, 기대·실제 결과, 판정, 증거 경로 |

JSONL은 한 줄에 JSON 객체 하나다. 중간에 로그가 깨졌으면 검증 도구가 해당 줄을 오류로 보고하며 조용히 건너뛰어 성공률을 높이지 않는다. 로그 기록 실패·디스크 부족은 운영 오류로 드러내고 측정 증거 미완료로 처리한다.

실행 종료 후 S3의 `outputs/runs/<run_id>/`에 필요한 증거를 복사한다. 제어 요청 처리 안에서 매번 S3 업로드를 기다리지 않는다. PEM, AWS 자격증명, 개인 영상은 로그·Git·S3 공개 자료에 넣지 않는다.

## 9. 계약 완료 기준

- [ ] 정상·경보·관측 불가·해제·초기화 샘플을 Python과 TypeScript에서 같은 의미로 해석.
- [ ] 알 수 없는 ID·추가 필드·다른 실행·낮은 순번·이벤트 충돌 거부.
- [ ] 명령 만료·갱신·다른 실행 전환을 클라이언트 시험으로 검증.
- [ ] 계약 샘플과 실제 API 응답의 차이가 없음.
- [ ] 공간 변경 시 버전·시나리오·명령이 함께 갱신됨.
- [ ] 조회 성공·명령 발행·적용 응답·실제 화면 관찰이 구분됨.

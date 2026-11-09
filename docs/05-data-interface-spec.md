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
| sources | array | source_id, source_type, zone_id, required, freshness_ms, allowed_hazard_types |
| signs | array | sign_id, node_id, faces |
| assumptions | array | 항목·근거·가정 내용·검토자 |
| provenance | object | 안내도 URL·확인일·자료 작성자 |

`position`은 `{ "x": 0, "y": 0, "z": 0 }`이며 y가 높이다. 평면도 가로축은 +x, 위쪽은 -z로 맞춘다. 층별 이미지 원점·축척·평행이동은 `coordinate_system`에 기록한다. 단위는 모델용 m로 표시하되 실측하지 않았다면 `measured: false`를 둔다.

`polygon`은 해당 층 평면의 `{ "x": number, "z": number }` 점 3개 이상으로 이루어진 배열이다. 모든 좌표·cost는 유한한 수여야 한다. node.kind는 JUNCTION·DOOR·STAIR·EXIT 중 하나다. 동일 층 연결을 원칙으로 하되 계단 edge만 층간 노드를 연결한다. 반복점·자기 교차·좌표 범위 오류는 공간 검수에서 확인한다. zone의 차단 목록은 그래프 ID를 참조하며 연기 모양의 크기로 자동 추론하지 않는다.

통로는 **방향이 있는 edge**다. edge.kind는 CORRIDOR·DOOR·STAIR 중 하나다. 양방향 이동은 반대 방향 edge를 각각 등록한다. 계단은 실제로 연결된 두 층의 노드를 잇고 복도와 구분한다. traversable은 boolean이고 door_open은 DOOR에서 boolean, 그 외 null이다. 문이 닫혀도 `traversable: true`일 수 있다. 문 개방 상태만으로 경로에서 제거하지 않는다.

### 2.2 관측원과 유도등

관측원 유형은 `VIDEO_AI`, `SIM_SMOKE_DETECTOR`, `SIM_SPRINKLER`, `MANUAL_TEST`다. 유형은 설정에서 고정하고 이벤트가 다른 유형으로 가장하면 거부한다. 영상 전체를 한 구역에 매핑하는 기본안에서 픽셀 좌표를 실제 건물 발화 좌표라고 표현하지 않는다.

`allowed_hazard_types`는 비어 있지 않은 중복 없는 배열이다. VIDEO_AI는 FIRE·SMOKE의 부분집합, SIM_SMOKE_DETECTOR는 SMOKE, SIM_SPRINKLER는 SPRINKLER만 지정한다. MANUAL_TEST도 허용할 원인을 명시한다. 이벤트는 유형과 이 목록을 모두 만족해야 한다.

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

EXIT 표시는 유도등이 활성 출구 노드에 있을 때만 사용한다. 이때 매핑은 자기 노드 ID → EXIT, default_next_node_id도 자기 노드 ID다. 자기 자신으로 향하는 edge는 만들지 않는다. 발행 명령의 next_node_id는 null이다. 그 외 매핑은 통행 가능한 출발 edge의 다음 노드여야 한다.

### 2.3 3D 렌더 전용 형상 자료

벽·바닥·계단의 표시용 형상은 Building 계약에 포함하지 않는다. Building은 제어기 입력이며 정의하지 않은 필드를 거부하므로, 형상 필드를 합친 JSON은 건물 로딩 단계에서 거부한다. 제어기는 Building의 노드·통로·계단 연결을 경로 계산에 사용하고, 렌더링용 형상 자료는 사용하지 않는다.

형상은 별도 파일 `data/space/wfi-geometry-v1.json`으로 관리한다. 형식과 좌표 근거는 [공간 기준 문서](../data/space/README.md)를 정본으로 하며, 좌표계·층 정렬은 해당 문서 2절, 형상 필드와 관리 규칙은 [10.1절](../data/space/README.md#101-3d-형상-파일)을 따른다.

프론트는 현재 실행의 공간 자료를 `GET /api/building`으로 받고, 형상 자료는 정적 파일로 별도로 받는다. 두 자료를 합쳐 서버 입력으로 보내지 않으며, 3D 표시 전에 두 자료의 `building_id`와 `building_version`을 비교한다.

두 값이 모두 같을 때만 공간 자료와 형상 자료를 함께 사용한다. 하나라도 다르면 3D 표시를 하지 않고 건물 ID 또는 버전 불일치를 화면에 표시한다. 이때 형상 불일치를 근거로 경로나 유도등 안내를 바꾸지 않으며, 경로와 유도등 안내는 계속 서버 결과를 따른다.

공간 자료의 구조·배치·경로 비용 등을 변경하면 `wfi-v1.json`의 `building_version`을 올리고, 형상 자료의 값도 같은 번호로 맞춘다. 형상 자체가 바뀌지 않았더라도 두 파일의 자료 버전은 함께 갱신한다. 배포 시에는 서버가 제공하는 공간 자료와 정적 형상 파일이 같은 건물 ID·자료 버전인지 확인한다.

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

VIDEO_AI의 ALARM·OBSERVATION에는 실제 프레임 위치인 media_time_ms가 필요하다. HEARTBEAT·UNAVAILABLE에서는 프레임 위치가 없으면 null이다. 비영상 관측원은 media_time_ms·confidence가 null이다. UNAVAILABLE에서 reason_code는 필수이며 나머지 이벤트에서는 null이다.

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

face의 mode는 `DEFAULT`, `DYNAMIC`, `NO_ROUTE`, `UNKNOWN`이다. DEFAULT도 확인된 정상 조건에서만 제공한다. DYNAMIC은 EMERGENCY뿐 아니라 필수 관측 불가 구역을 제외한 DEGRADED의 안내에도 사용하므로 화재 발생 자체를 뜻하지 않는다. NO_ROUTE·UNKNOWN에서는 display·next_node_id·exit_id가 null이며 reason_codes가 비어 있으면 안 된다.

### 5.2 단말 적용 순서

1. URL의 sign_id를 확인하고 `/api/session`에서 현재 실행·건물 버전을 읽는다.
2. 명령 조회는 한 번에 하나만 진행한다. 요청 시작 시 브라우저 monotonic 시각을 기록한다.
3. sign_id·run_id·building_version·sequence를 확인한다. 낮은 순번, 지난 실행, 다른 단말 명령은 적용하지 않는다.
4. 유효 기한은 **요청 시작 시각 + valid_for_ms**로 보수적으로 계산한다. 네트워크에서 지연된 시간을 다시 유효기간으로 더하지 않는다.
5. face 전체를 한 상태 갱신으로 반영한다. UI 반영 완료 후 적용 응답을 보낸다.
6. 기한 내 새 명령이 없으면 이전 화살표를 제거하고 UNKNOWN·COMMAND_EXPIRED로 전환한다.
7. 서버 실행이 바뀌면 기존 명령을 폐기하고 session을 다시 읽은 뒤 새 명령을 받는다.

서버는 guidance_version이 같아도 매 조회에 새로운 command_sequence·command_id를 발행한다. 동일한 방향을 유지하면서 유효기간을 갱신할 수 있다. 늦은 동일 버전 응답도 순번으로 배제한다.

명령 기록 중 관측이 만료되어 안내 버전이 바뀌면 COMMAND_MISMATCH, 명령 자체가 만료되면 COMMAND_EXPIRED(409)로 응답하고 해당 명령을 반환하지 않는다. 단말은 실패 응답으로 기존 명령의 기한을 연장하지 않고 새 명령을 다시 조회한다. ACK 처리도 로그 저장 후 만료를 반영한 현재 SignState를 반환한다.

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

B03의 성공 응답은 HTTP 200과 해당 유도등의 `SignState` 객체(`sign_id`, `faces`, `latest_command`, `application_status`, `terminals`)다. 200은 응답 접수이며 유효한 과거 명령의 ACK는 현재 상태를 PENDING으로 남길 수 있다. 다음 규칙을 따른다.

- 같은 단말·명령의 동일 ACK는 중복으로 기록하고 기존 수신 시각을 갱신하지 않는다. 내용이 달라지면 COMMAND_MISMATCH로 거부한다. 명령이 이미 만료됐다면 중복 ACK도 COMMAND_EXPIRED다.
- 단말별 마지막 ACK는 명령 순번이 더 높은 경우에만 갱신한다. 서로 다른 terminal_instance_id가 같은 sign_id에 유효 ACK를 보내면 실행 동안 DUPLICATE_TERMINAL로 표시한다. 이는 확인된 인스턴스 이력이며 현재 온라인 여부를 뜻하지 않는다. 자동으로 하나를 선택하거나 이력을 지우지 않고 새 실행에서 초기화한다.
- 적용 상태 판정 순서는 NOT_ISSUED → 중복 인스턴스 확인 → 명령 만료 확인 → 현재 안내·명령과 ACK 일치 확인이다. 현재 명령의 유효 APPLIED는 APPLIED, 유효 REJECTED는 REJECTED, 아직 확인되지 않은 현재 안내는 PENDING이다.
- 명령·ACK 로그 쓰기에 실패하면 503으로 드러내며 적용 성공을 반환하지 않는다. 서버의 APPLIED는 검증된 응답을 받았다는 뜻이고, 실제 화면 관찰은 별도다.

## 6. API 목록

| 메서드·경로 | 요청 | 성공 응답·용도 |
| --- | --- | --- |
| GET /api/health | 없음 | 서비스 생존. 모든 기능 정상이라는 뜻은 아님 |
| GET /api/session | 없음 | run_id, 건물 버전, controller_mode, schema_version |
| GET /api/building | 없음 | 현재 실행이 사용하는 검증된 공간 자료 |
| GET /api/state | 없음 | 하나의 안내 버전으로 묶인 상태·경로·단말 적용 현황 |
| GET /api/explanations/current | 없음 | A05 설명 작업자(8002)의 현재 설명·기준 버전·기한·상태. [A05-2 실행](ai/a05-explanation-api.md) |
| POST /api/events | 3절 이벤트 | 수락·중복 여부와 해당 판단 버전 |
| GET /api/signs/{sign_id}/command | 없음 | 단말별 새 명령 |
| POST /api/signs/{sign_id}/ack | 5절 응답 | 해당 SignState. 응답 접수와 현재 적용 상태를 구분, 검증 실패 시 오류 |
| POST /api/control/arm | run_id, reason | 초기 관측 확인 후 시연 시작 허용 |
| POST /api/control/clear | run_id, source_id, hazard_type, reason | 특정 원인 확인 해제. 원인 없으면 명시 오류 |
| POST /api/control/reset | run_id, reason | 기존 실행 종료·새 run_id 생성·INITIALIZING |
| GET /sim/state | 없음 | 별도 시나리오 서버의 현재 정답·진행 시각·출처 |
| GET /sim/health | 없음 | 별도 시나리오 서버의 생존·진행 상태 |

`/sim` API는 8001의 시나리오 실행기가 제공한다. 제어기 코드가 이 API를 호출하거나 시나리오 정답 파일을 읽으면 안 된다. 건물·설비 설정은 공유할 수 있지만 정답 위험·미래 변화·기대 경로는 제어 입력이 아니다.

제어 요청 arm·clear·reset은 표의 필드 외에 schema_version=1을 포함한다. reason은 비어 있지 않은 문자열이다. 정상 처리의 HTTP 상태는 200으로 통일한다. arm은 `{ "run_id": "...", "controller_mode": "NORMAL", "armed": true }`, clear는 `{ "run_id": "...", "source_id": "...", "hazard_type": "SMOKE", "cleared": true, "guidance_version": 4 }`, reset은 `{ "previous_run_id": "...", "run_id": "...", "controller_mode": "INITIALIZING" }`를 반환한다. arm 당시 활성 경보가 있으면 controller_mode는 EMERGENCY다.

`/api/state`의 최상위 필드는 schema_version, run_id, building_id, building_version, guidance_version, generated_at, controller_mode, sources, active_causes, blocked_nodes, blocked_edges, routes, signs다. routes는 node_id, next_node_id, exit_id, path_node_ids, cost, reason_codes를 가진 객체 배열이다. 안내 불가이면 next_node_id·exit_id·cost는 null, path_node_ids는 빈 배열이다. signs는 sign_id, 최신 command_id·sequence·guidance_version, 적용 상태와 terminal_instance_id별 마지막 ACK를 포함한다.

조회 응답은 `Cache-Control: no-store`로 제공한다. 클라이언트도 캐시를 사용하지 않는다. POST 제어 기능은 기본 배포에서 SSH 접속 권한이 있는 팀원만 접근하는 내부 경로다. 공개 배포가 결정되면 인증·권한을 먼저 구현하고 무인증 reset·clear·event 전송을 열지 않는다.

B01에서 health·session·building·state·events·arm·clear·reset, B02에서 상태별 경로, B03에서 현재 표시면·단말별 명령·ACK·감사 로그를 구현했다. INITIALIZING은 INITIALIZING 사유와 UNKNOWN 표시다. NORMAL은 DEFAULT, DEGRADED·EMERGENCY는 DYNAMIC 또는 NO_ROUTE이며, 등록된 출구 지점은 EXIT, 지원하지 않는 면은 NO_ROUTE·UNSUPPORTED_DISPLAY다. DEGRADED에서도 필수 관측 불가 구역의 차단 사유는 REQUIRED_OBSERVATION_UNKNOWN으로 남으며, 경로가 없으면 ORIGIN_BLOCKED·NO_REACHABLE_EXIT 등 해당 위치의 사유를 제공한다. 안내 가능한 표시면에는 실패 사유를 넣지 않는다. B04에서 `/sim/*`와 설정·운영·로그 검증 도구를 구현했다. 실제 브라우저 단말은 후속 구현이다. 경로·표시면 조회는 명령 발행·적용 완료를 의미하지 않는다.

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
| 409 | COMMAND_MISMATCH / COMMAND_EXPIRED | 명령·표시면·응답 불일치 또는 기한 만료. 적용 성공으로 집계하지 않음 |

네트워크 재시도는 같은 event_id·sequence로 제한한다. 오래된 경보를 몇 분 뒤 정상 신규 관측처럼 제출하지 않는다. 공급자가 재시작해 순번을 잊었으면 시연을 명시적으로 새 실행으로 시작한다.

## 7. 시나리오 형식

시나리오는 schema_version, scenario_id, building_id, building_version, seed, duration_ms, start_trigger, initial_observations, smoke_timeline, observation_rules, faults를 가진다. 기본 start_trigger는 ARM이다.

- `smoke_timeline`: 시간·구역·0~1 표현 강도. 실제 농도·물리 예측값이 아님.
- `observation_rules`: 가상 관측원, 임계값, 관측 주기, 지연. 정답에서 이벤트를 만드는 시험 장치의 규칙.
- `faults`: 모의 관측 DROP·추가 DELAY·UNAVAILABLE 구간. 실제 프로세스 종료 시험은 별도로 수행한다.
- `initial_observations`: 초기 필수 관측 확인. 모든 구역을 무조건 정상이라고 간주하지 않음.
- `seed`: 난수를 쓸 때만 의미가 있으며 반복 시험에서 고정.
- 시나리오 실행기는 시작 시 현재 run_id를 읽고 고정한다. 실행 도중 run_id가 바뀌면 전송을 중단한다.
- arm 전에는 초기 관측·상태 확인만 전달하고 주요 시간표는 대기한다. arm 확인을 시나리오 t=0으로 한다. 실제 AI 경보를 시작 조건으로 쓰는 기능은 별도 설정·시험 후 추가한다.

실행 설정 샘플은 `data/scenarios/two-route-smoke.runtime.json`이며 기존 `two-route-smoke.json`은 독립적인 Q02 기대 결과 문서다. 실행 설정에는 기대 경로를 넣지 않는다.

| 배열 | 요소 필드·조건 |
| --- | --- |
| smoke_timeline | `time_ms`(0 이상 정수), `zone_id`, `smoke`(0~1). 구역별 t=0 필수, 같은 구역·시각 중복 금지, duration 이내. 값은 다음 항목까지 유지 |
| observation_rules | `source_id`, `threshold`(0 초과~1), `interval_ms`(양의 정수), `delay_ms`(0 이상). 등록된 SIM 관측원만 허용, source 중복 금지 |
| initial_observations | rule source마다 `source_id`, `event_kind`(OBSERVATION/ALARM), `hazard_type`(null/SMOKE/SPRINKLER). 초기 연기·임계값·관측원 종류와 일치해야 함 |
| faults | `source_id`, `kind`(DROP/DELAY/UNAVAILABLE), `start_ms`, `end_ms`, `delay_ms`. [start,end), duration 이내, 같은 source 구간 중복 금지. DELAY만 양의 추가 지연, 나머지는 0 |

seed는 현재 결정적 시간표에서 난수를 사용하지 않으므로 결과에 영향을 주지 않는다. 관측원 임계값·초기값은 실제 설비 사양이 아닌 시험 가정이다. DROP도 관측 순번을 소비하고, DELAY는 원래 시각을 보존하며, UNAVAILABLE은 SMOKE 경보를 자동 해제하지 않는다. arm 전에는 초기 관측을 즉시·주기적으로 전송하고 주요 시간표·fault는 대기한다. arm 확인 후에 delay·fault 규칙을 적용한다. 오래 지연된 마지막 큐는 완료 시 버리며 이후 입력을 만들지 않는다. 같은 source를 다른 공급자와 공유하지 않는다. 초기 관측에서 순번 충돌이 발생하면 SOURCE_CONFLICT로 중단한다. 이는 운영 충돌 감지이며 분산 소유권·인증 잠금 기능은 아니다.

`/sim/state`의 공통 형식은 `SimulationState`다. schema_version, building_id, building_version, scenario_id, 고정 run_id, simulation_time_ms, simulation_sequence, status, zones(`{zone_id, smoke}` 객체 배열), error_code(null 또는 문자열)를 제공한다. status는 WAITING_FOR_ARM·RUNNING·COMPLETED·FAILED·STOPPED다. 시간과 순번은 프로세스가 진행시키며 GET 요청은 진행시키지 않는다. 기동 시 백엔드·설정 불일치면 서비스가 뜨지 않는다. 실행 중 오류면 FAILED 상태를 유지하고 새 실행기로 재시작해야 한다. GET /sim/health는 현재 status만 반환하므로 HTTP 200만으로 정상 진행을 판정하지 않는다. 응답은 no-store다. 현재 값 외 시간표·미래 값·경로·기대 결과는 노출하지 않는다. 관제는 연기 정답과 제어기 관측을 별도 범례로 표시한다.

## 8. 저장·감사 로그

| 파일 | 기록 |
| --- | --- |
| manifest.json | schema_version=1, run_id, building_id/version/SHA-256, 코드 commit·dirty(null 허용), Python·OS, 시작·종료·closed·마지막 순번 |
| building.json | 해당 실행이 사용한 건물·설비 설정의 정확한 사본 |
| events.jsonl | 수신·거부·중복 입력, 수신 UTC·서버 monotonic, 거부 이유 |
| decisions.jsonl | 시작·종료·초기화, 원인 이벤트/운영 명령/만료, 적용 후 상태·차단·경로·표시면·안내 버전 |
| commands.jsonl | 명령 ID·순번·대상·안내 버전·발행 시각·기한 |
| acks.jsonl | 수신·검증 결과, 적용 여부, 서버 수신 시각 |
| verification.json | scope=LOG_INTEGRITY, PASS/FAIL, 기록·명령·ACK 개수, 파일별 해시, 오류 파일·줄·사유 |

JSONL은 한 줄에 JSON 객체 하나다. 중간에 로그가 깨졌으면 검증 도구가 해당 줄을 오류로 보고하며 조용히 건너뛰어 성공률을 높이지 않는다. 로그 기록 실패·디스크 부족은 운영 오류로 드러내고 측정 증거 미완료로 처리한다.

B03의 commands 로그는 전체 `command`와 `issued_monotonic_ms`·`expires_at_monotonic_ms`를 기록한다. acks 로그는 원본 payload·accepted/duplicate/rejected·verified·confirms_current·서버 수신 시각·server_ack_elapsed_ms를 기록하며 거부 시 오류 코드를 남긴다. verified는 해당 발행 명령의 APPLIED 내용 검증, confirms_current는 수신 시 현재 안내·최신 명령과의 일치다. 중복 단말 여부까지 반영한 전체 적용 판정은 SignState에서 확인한다. 서버 경과 시간은 클라이언트의 화면 렌더링 시간과 구분한다. decisions의 안내 변경 기록에는 같은 버전의 경로와 표시면을 함께 남긴다.

B04의 JSONL 공통 필드는 run_id, recorded_at(UTC), server_monotonic_ms, record_sequence(1부터 네 파일 전체에서 연속)다. manifest의 closed는 생성 시 false이며 reset·정상 shutdown에서만 true로 확정된다. 검증기는 종료 시각·이유·last_record_sequence와 마지막 reset/stop 결정을 확인한다. 기록 실패 시 제어기는 CONTROLLER_NOT_READY로 중단하고 미완료 manifest를 유지한다. 검증기가 원본 로그를 고치거나 누락을 보충하지 않는다.

시나리오 기록은 `simulations/<시나리오 실행 UUID>/manifest.json`, `scenario.json` 사본, `scenario.jsonl`이다. 샘플·예정 전달 시각·누락·전송 결과·실패·완료와 남은 큐 폐기 개수를 남긴다. 이 자료에는 시험 정답이 있으므로 제어기 입력과 분리한다. LOG_INTEGRITY 검증기는 제어 로그만 검사하며 시나리오 물리 타당성·영상 추론·실제 화면·최단 경로 재계산을 판정하지 않는다. `acks_applied`, `acks_confirming_current`는 조건에 맞는 ACK 레코드 수로 중복 응답이 포함될 수 있다. 단말 수·독립 적용 횟수로 해석하지 않는다. accepted/duplicate 개수는 별도 제공한다.

실행 종료 후 S3의 `outputs/runs/<run_id>/`에 필요한 증거를 복사한다. 제어 요청 처리 안에서 매번 S3 업로드를 기다리지 않는다. PEM, AWS 자격증명, 개인 영상은 로그·Git·S3 공개 자료에 넣지 않는다.

## 9. 계약 완료 기준

- [ ] 정상·경보·관측 불가·해제·초기화 샘플을 Python과 TypeScript에서 같은 의미로 해석.
- [ ] 알 수 없는 ID·추가 필드·다른 실행·낮은 순번·이벤트 충돌 거부.
- [ ] 명령 만료·갱신·다른 실행 전환을 클라이언트 시험으로 검증.
- [ ] 계약 샘플과 실제 API 응답의 차이가 없음.
- [ ] 공간 변경 시 버전·시나리오·명령이 함께 갱신됨.
- [ ] 조회 성공·명령 발행·적용 응답·실제 화면 관찰이 구분됨.

## 10. C02 구현·팀 인계 기준

### 10.1 기준 파일과 실행

- 검증 모델과 상태를 변경하지 않는 문맥 검사: `backend/contracts/`.
- 프론트 공통 형식: `contracts/types.generated.ts`. `python -m tools.export_contracts`로 생성하며 직접 수정하지 않는다.
- 수락 샘플: `data/contracts/valid.json`. 거부 샘플: `data/contracts/rejected.json`의 원본 샘플·변경 필드·기대 오류.
- 계약용 공간: `data/fixtures/two-route-v1.json`. 07번의 가상 두 경로 구조이며 WFI 건물 자료가 아니다. 독립 경로 정답·공간 검수는 Q02/M03에서 별도 확인한다.
- 검사: `python -m pytest tests -q`, `python -m tools.export_contracts --check`, `npm run test:contracts`.

샘플은 고정된 가상 시각의 독립 사례다. 서로 같은 event_id·순번을 사용하는 예도 있으므로 목록을 순서대로 실제 API에 전송하지 않는다. 새 시험 이벤트를 만들 때 현재 session·새 event_id·관측원별 순번·실제 관측 시각을 사용한다. 이미 발생한 오래된 관측의 시각이나 run_id를 바꿔 신규 입력으로 가장하지 않는다.

Python 모델이 필수 필드·자료형·의미 조합을 검증한다. TypeScript는 같은 Python 모델에서 생성한 **정적 형식**이고 동일 JSON 샘플을 컴파일 검사한다. 정수 범위·UTC 날짜·동적 ID·만료를 TypeScript 형식만으로 검증했다고 보지 않는다. 실제 브라우저의 수신 검증·만료·재연결은 P01/P04에서 구현·시험한다. JSON Schema의 구조 형식은 Pydantic 모델에서 생성하며 [공식 문서](https://docs.pydantic.dev/latest/concepts/json_schema/)를 따른다.

### 10.2 원시값·문맥 검사

- 정수는 JavaScript에서 정확하게 공유할 수 있는 `2^53-1` 이하이며 bool·문자열·소수로 대체하지 않는다. schema_version은 1, building_version·순번·유효기간은 1 이상, guidance_version은 0부터 시작한다.
- UUID는 소문자 하이픈 표기다. UTC 시각은 `YYYY-MM-DDTHH:mm:ss[.소수초]Z`를 쓰며 소수초는 최대 6자리다. 존재하지 않는 날짜·시간을 거부한다.
- nullable 필드도 키를 생략하지 않는다. 모든 정의된 객체에서 추가 필드를 거부한다.
- `parse_contract(모델명, JSON객체)`는 필드·형식 오류를 422/SCHEMA_VALIDATION_FAILED, 허용하지 않는 관측 조합을 400/INVALID_EVENT_COMBINATION으로 구분한다.
- `check_event`는 등록된 관측원·실행·건물·중복·순번·관측 나이를 검사한다. 같은 이벤트 재전송은 상태를 갱신하지 않으며 만료 후 재전송도 유효기간을 연장하지 않는다.
- `EventContext.now`는 같은 서버의 UTC다. 기본 미래 허용 오차는 0ms이며 변경 시 시험 조건에 기록한다. 유효기간은 관측 나이를 차감하고 경계 시각부터 만료다. 시험 자료의 3000ms는 실제 센서 기준이 아니다.
- `check_command`는 실행·건물·대상·순번·표시면 전체·방향 매핑·활성 출구를 검사한다. 경로의 위험 회피와 도달 여부 판정은 B02의 책임이다.
- `check_ack`는 발행 명령과 응답을 비교하고 서버 내부 monotonic 기한을 검사한다. APPLIED일 때만 true, 유효한 REJECTED는 false다. 이 반환값은 물리 등기구 동작 증거가 아니다.
- 위 함수는 기록을 갱신하지 않는다. 수신 직렬화·중복 이력·시계 관리·상태 갱신은 B01/B03/B04에서 연결한다. 9절의 실제 API·브라우저 시험은 이 단계에서 완료 처리하지 않는다.

B01은 이 중 관측 수신·이력·시계·원인별 상태·arm/clear/reset을 API에 연결했다. 명령·ACK와 브라우저 동작 시험은 계속 후속 범위다. SourceState의 last_event_id·last_source_sequence는 마지막 수락 입력이고, 영상 HEARTBEAT는 last_observed_at·유효기한을 갱신하지 않는다. 오류·관측 만료·확인 해제의 운영자 기록명·시각·이유는 실행별 감사 로그에 남긴다.

### 10.3 공간의 세부 객체

| 객체 | 필드 |
| --- | --- |
| coordinate_system | unit=m, measured(boolean), up_axis=+y, plan_right_axis=+x, plan_up_axis=-z, origin(Position), floor_transforms |
| floor_transforms 항목 | floor_id, scale(양수), translation(Position). 등록된 층마다 하나 |
| assumptions 항목 | item, basis, description, reviewer(문자열 또는 null) |
| provenance | source_url(문자열 또는 null), checked_on(YYYY-MM-DD), author, description |

Position은 x·y·z, polygon 점은 x·z다. 좌표는 유한한 수다. 모든 ID 참조·ID 중복·층간 edge 종류를 검증한다. 폴리곤 자기 교차·벽 관통·안내도 일치와 기본 경로의 실제 도달 여부는 공간·경로 검증에서 추가로 확인한다.

### 10.4 상태 응답의 세부 객체

| 배열·객체 | 필드·의미 |
| --- | --- |
| sources 항목 | source_id, validity(INITIALIZING/VALID/UNAVAILABLE/STALE), last_event_id·last_observed_at·last_source_sequence(초기에는 null) |
| active_causes 항목 | source_id, hazard_type, first_event_id, last_event_id, activated_at. 활성 원인만 포함하며 해제 기록은 감사 로그에 남김 |
| blocked_nodes 항목 | node_id, source_ids, reason_codes(ACTIVE_ALARM/REQUIRED_OBSERVATION_UNKNOWN) |
| blocked_edges 항목 | edge_id, source_ids, reason_codes(위 두 코드 또는 NOT_TRAVERSABLE) |
| signs 항목 | sign_id, faces(현재 안내 표시면 결과), latest_command(마지막 발행 명령 또는 null), application_status, terminals |
| terminals 항목 | terminal_instance_id, last_ack, received_at(서버 UTC), verified(서버 응답 검증 결과) |

application_status는 NOT_ISSUED/PENDING/APPLIED/REJECTED/EXPIRED/DUPLICATE_TERMINAL이다. 마지막 발행 명령·과거 ACK는 감사용으로 현재 안내보다 이전 버전일 수 있다. **현재 안내는 faces이고, 과거 명령을 현재 적용 성공으로 표시하지 않는다.** APPLIED는 현재 안내 버전·명령·표시면과 일치하는 검증된 단말 하나의 ACK가 있을 때만 허용한다. 단말이 여러 개면 중복 인스턴스를 숨기지 않는다.

출구 자체의 Route는 path_node_ids=[현재 노드], next_node_id=null, cost=0, exit_id=해당 출구, reason_codes=[]다. 안내 불가 Route는 6절의 null·빈 경로·사유 규칙을 따른다.

## 11. F11 상황 설명 계약 — A05

설명은 기존 `StateSnapshot`·관측·명령·ACK에 필수 필드를 추가하지 않는 별도 DTO/API다. A05-1에서 Python 모델·생성 TypeScript·수락/거부 샘플·계약 시험을 추가했다. [A05-2](ai/a05-explanation-api.md)는 별도 8002 프로세스의 실제 API·호출을 구현한다. 서버 상시 서비스 배포·독립 V15 완료를 의미하지 않는다.

| 필드 | 형식·규칙 |
| --- | --- |
| schema_version | 1 |
| run_id·building_id·building_version·guidance_version | 현재 설명의 근거 세션과 안내 버전. 모든 ID는 기존 계약 형식 |
| status | PENDING / READY / UNAVAILABLE |
| basis_generated_at | 근거 스냅샷의 generated_at(UTC) |
| generated_at·expires_at | READY에서는 UTC 시각, 나머지 상태에서는 null. expires_at은 근거 시각 + 설정 유효기간을 넘지 않음 |
| summary | READY에서 비어 있지 않은 한국어 설명, 그 외 null |
| fact_refs | 작업자가 제공한 사실 ID의 중복 없는 배열. READY에서 한 개 이상, 그 외 빈 배열 |
| model_id·prompt_version | READY에서 실제 호출 모델 ID·고정 프롬프트 버전, 그 외 null 허용 |
| error_code | UNAVAILABLE이면 BEDROCK_UNAVAILABLE / INVALID_RESPONSE / STALE_BASIS / EXPLANATION_LOG_ERROR / DISABLED 중 하나, 그 외 null |

- 사실 ID는 해당 실행·버전 안에서만 유효하다. 예: 활성 원인의 `cause:<source_id>:<hazard_type>`, 차단 대상의 `blocked-node:<node_id>`·`blocked-edge:<edge_id>`, 계산 결과의 `route:<node_id>`. 실제 존재하는 항목만 입력 목록에 제공한다.
- 현재 제어 모드는 `mode` 사실 ID의 controller_mode 값으로 제공한다. A05-1의 [계약·허용 근거 인계](ai/a05-explanation-contract.md)는 Python 모델·생성 TypeScript·샘플과 순수 추출 함수를 제공한다. 실제 API·호출·응답 채택 검사는 A05-2에서 연결한다.
- 모델은 summary·fact_refs만 생성한다. 실행·건물·안내 버전과 기한·모델 ID는 작업자가 붙이며 모델 출력으로 덮어쓰지 않는다. 알 수 없는 사실 ID·깨진 JSON·빈 설명은 INVALID_RESPONSE다.
- API는 알려진 상태를 HTTP 200과 `Cache-Control: no-store`로 반환한다. 아직 현재 제어 세션을 읽지 못하면 503을 반환하고 이전 실행 결과를 대신 내보내지 않는다. 프론트는 설명 조회 실패를 설명 영역에만 반영한다.
- UI는 `/api/state`의 현재 실행·건물·안내 버전과 모두 일치하는 READY만 표시한다. 안내 변경·reset·네트워크 단절·설명 만료 시 문장을 숨긴다. 남은 유효시간은 근거 시각부터 계산하고 수신 시 TTL을 새로 시작하지 않는다.
- 서로 다른 시계로 만료를 추정하지 않도록 서버 시각·응답 나이를 이용하고 불확실하면 표시하지 않는다. 형식·기한 검사와 자연어의 사실 정확성 시험은 별개다.
- 이 API는 제어 동작을 수행하지 않는다. Bedrock 결과를 `/api/events`·clear·arm·유도등 명령에 전달하는 연결은 두지 않는다.

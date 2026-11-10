# B05 위치·표지·시연 화면 연결 기준

관련: [#67](https://github.com/JinsuBae2/saferoute/issues/67). 후속: [#68](https://github.com/JinsuBae2/saferoute/issues/68) WFI 표시 자료, [#71](https://github.com/JinsuBae2/saferoute/issues/71) 개인 경로, [#70](https://github.com/JinsuBae2/saferoute/issues/70) 표지, [#72](https://github.com/JinsuBae2/saferoute/issues/72) 시험 화재 조작.

## 1. 표시 자료

`BuildingDisplay`는 `Building`과 별도 정적 JSON이다. 기존 형상 자료처럼 웹 빌드의 정적 자산으로 전달하고 제어 API에 보내지 않는다. 새 제어 API·경로 계산기를 만들지 않는다. Python 정본은 `backend/contracts/display.py`, TypeScript는 `contracts/types.generated.ts`에서 생성한다. 수락 샘플은 `data/contracts/valid.json`의 `building_display`이며 TWO_ROUTE 시험 구조의 합성 표시 예제다. WFI 실제 표시 자료와 화면 연결은 #68에서 추가한다.

| 필드 | 의미·연결 |
| --- | --- |
| schema_version, building_id, building_version | 형식 1, 현재 Building과 동일한 건물·자료 버전 |
| floor_labels, zone_labels, node_labels | 각 ID를 키로 한 한글 이름. 모든 기존 ID를 정확히 포함 |
| exit_labels | exit_id별 고정 출구 위치 표지 이름. 위치는 Building.exits → node_id → position |
| sources | source_id별 label·installation. 관측 구역은 기존 Building.sources.zone_id를 사용 |
| signs | sign_id별 label·kind. 위치·양면 기준은 Building.signs의 node_id·faces를 사용 |

`installation`은 `{floor_id, position: {x,y,z}, basis: SIMULATED | MEASURED}` 또는 명시적 null이다. 위치를 모르면 null을 사용하며 관측 구역 중심을 실제 카메라 설치점으로 단정하지 않는다. SIMULATED는 가상 배치, MEASURED는 실측 좌표계를 쓰는 물리 카메라만 허용한다. 같은 층·구역에 설치되어 있다는 가정도 하지 않는다. 좌우 이름은 Building 좌표의 +x/−z 기준 평면도에 고정하고 화면 회전에 따라 바꾸지 않는다. 층 펼침은 렌더 변환이며 원본 좌표를 수정하지 않는다.

`signs.kind`는 DIRECTIONAL 또는 EXIT_LOCATION이다. EXIT_LOCATION은 기존 출구 노드와 자기 노드→EXIT 표시면 매핑을 가진 제어 표지에만 허용한다. 별도 제어 단말이 없는 출구도 exit_labels로 위치를 표시할 수 있다. 출구 위치 표시는 사용 가능·안전·ACK 성공 판정이 아니다. 위험·안내 불가·만료 상태는 기존 서버 결과대로 함께 표시한다.

검증 순서: `parse_contract("BuildingDisplay", payload).validate_for(building)`. 구조만 파싱하면 참조 검증은 끝나지 않는다. 전체 ID 집합·설치 층·표지 의미까지 확인한다. CLI는 `python -m tools.validate_config --building <건물.json> --display <표시.json>`이다. 기존 `--scenario`와 함께 사용할 수 있다.

화면은 로딩 시 구조를 검사하고 현재 Building의 ID 집합·건물 버전과 대조한 뒤 사용한다. 형식/참조/버전 오류 시 해당 표시 자료를 사용하지 않고 오류와 원래 ID를 보여 준다. 표시 실패로 제어 상태·경로를 바꾸거나 숨기지 않는다. 파일 이름의 v1과 building_version은 별개다. #68 이후 공간·설비 ID나 건물 버전 변경 시 표시 자료도 함께 맞춘다.

## 2. 현재 위치의 경로와 표지 상태

기존 `GET /api/state`의 한 응답에서 routes·signs를 함께 사용한다. 별도 출발점 설정 API는 필요 없다.

1. 화면에서 등록된 node_id를 출발점으로 선택한다. 수동으로 선택한 위치이며 실제 위치 추적 결과가 아니다.
2. `state.routes.find(route => route.node_id === selectedNodeId)`의 path_node_ids를 그대로 강조한다. 경로상의 층·계단·출구는 Building에서 연결한다. 클라이언트가 최단 경로나 고정 우회 경로를 새로 계산하지 않는다.
3. 경로가 없으면 reason_codes를 표시한다. `path_node_ids: [출구 노드]`는 이미 출구에 있는 정상 결과이고 빈 배열과 다르다.
4. 경로에 포함된 node_id를 설치 위치로 가진 sign_id를 찾아 `state.signs`의 faces·latest_command·application_status·terminals를 표시한다. FRONT/REAR는 각 표시면의 기존 방향 매핑이며 화면 시점 기준이 아니다.
5. 명령 발행은 PENDING, 검증된 현재 명령 ACK는 APPLIED다. NO_ROUTE/UNKNOWN, REJECTED/EXPIRED/DUPLICATE_TERMINAL과 구분하고 과거 ACK를 현재 적용으로 쓰지 않는다.
6. 비교용 이전 경로는 같은 실행·건물·출발점에 한정해 이전 guidance_version을 함께 표시한다. 실행/건물/출발점 변경이나 상태 조회 실패 시 현재 경로와 섞지 않는다. 화면 선택은 서버 상태나 설치 유도등 명령을 변경하지 않는다.

공통 샘플 `emergency_state`에서 출발 S는 S→B→Y, 출발 B는 B→Y, 출발 I는 NO_REACHABLE_EXIT다. SIGN-S는 FRONT RIGHT/REAR LEFT와 현재 검증 ACK의 APPLIED를, SIGN-B는 아직 발행하지 않은 NOT_ISSUED를 나타낸다. `state`는 초기 준비 상태다. 이들은 합성 연결 예제이며 실제 브라우저·물리 유도등 검증이 아니다. 이미 있는 `test_sign_guidance.py`가 발행/ACK·만료·관측 장애의 동작을 검증한다.

## 3. 시험 화재 제어 연결

현재 WFI v3에는 MANUAL_TEST가 없다. 따라서 이 버전에서는 임의 구역의 수동 FIRE 주입을 제공할 수 없다. #72에서 시험용 관측원을 건물 설정에 등록하고 새 실행으로 적용하며 공간/형상/표시 자료의 건물 버전을 함께 맞춘다. 현재 VIDEO_AI source_id를 시험 화재에 재사용하지 않는다.

| 작업 | 기존 API·입력 | 결과/실패 |
| --- | --- | --- |
| 발생 | POST /api/events, 등록된 MANUAL_TEST + 허용 FIRE, event_kind=ALARM | EventReceipt 수락. 경로는 다음 StateSnapshot으로 확인 |
| 해제 | POST /api/control/clear, 현재 run_id + 해당 source_id + FIRE + reason | 해당 원인만 해제. 다른 관측원의 경보·관측 장애는 유지 |
| 초기화 | POST /api/control/reset, 의도한 run_id + reason | 새 실행. 선택·비교 경로·순번 상태를 정리하고 관측 준비/arm을 다시 확인 |

`manual_fire`는 형식 예제이며 MANUAL-A가 기본 TWO_ROUTE/WFI에 등록됐다는 뜻이 아니다. 미등록 상태로 보내면 UNKNOWN_SOURCE(404), 유형/허용 원인 불일치 INVALID_EVENT_COMBINATION(400), 과거 실행·역순 입력은 RUN_MISMATCH/STALE_SEQUENCE(409), 임의 zone_id 추가는 SCHEMA_VALIDATION_FAILED(422)다. clear의 비활성 원인은 SOURCE_CAUSE_INACTIVE(409)다.

입력은 zone_id 없이 등록 source_id로 구역이 결정된다. source_sequence는 실행·관측원별 증가, 재전송은 동일 event_id·동일 본문이다. 시연 조작은 일반 조회와 구분하며 대상 구역·시험 출처·오류를 보여 준다. 화면에서 구역을 선택한 것만으로 발생시키지 않는다. 시연용 ALARM의 media_time_ms/confidence는 null이다. 전송 시각은 현재 UTC이며 지연된 입력을 새 관측처럼 바꾸지 않는다.

기존 `python -m tools.control event --file <event.json>`, `clear --run-id ... --source-id ... --hazard-type FIRE --reason ...`, `reset --run-id ... --reason ...`를 재사용할 수 있다. CLI/API는 로컬·SSH 내부 접근 범위를 유지한다. 공개 제어 API나 사용자 위치 수집 기능을 추가하지 않는다.

## 검증

`python -m pytest tests/test_display_contract.py tests/test_contract.py tests/test_contract_exports.py tests/test_sign_guidance.py tests/test_operating_tools.py -q`

`python -m tools.export_contracts --check` 및 `npm run test:contracts`로 Python·샘플·생성 TypeScript 일치를 확인한다. 실제 WFI 위치 이름/설치 근거는 #68, 화면 조작과 원인별 해제 시연은 #72에서 검증한다.

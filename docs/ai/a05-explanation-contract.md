# A05-1 설명 계약·근거 인계

관련: [#86](https://github.com/JinsuBae2/saferoute/issues/86), 상위 [#41](https://github.com/JinsuBae2/saferoute/issues/41), 관제 [#21](https://github.com/JinsuBae2/saferoute/issues/21).

## 이번 구현

`backend/contracts/explanations.py`의 `Explanation`은 [명세 11절](../05-data-interface-spec.md)의 별도 DTO다. 기존 StateSnapshot·관측·명령·ACK 필드는 바꾸지 않는다. `parse_contract("Explanation", payload)`로 검증하고 `python -m tools.export_contracts`로 TypeScript를 생성한다. 관제의 기존 설명 소비자는 생성 타입을 재사용하며 화면 동작은 유지한다.

- READY는 설명·사실 참조·모델·프롬프트·결과 시각이 모두 필요하다. 중복 사실 참조와 `basis_generated_at <= generated_at < expires_at` 위반을 거부한다.
- PENDING/UNAVAILABLE에는 설명·사실 참조·결과 시각을 담지 않는다. UNAVAILABLE만 오류 코드가 필수다.
- 수락 예제 3개와 거부 예제는 `data/contracts/valid.json`, `rejected.json`에 있다. 예제 문장·모델 ID는 계약 시험용이며 실제 Bedrock 응답이 아니다.
- 생성 TypeScript는 정적 형식이다. 상태별 조합·시간·참조 검증이 브라우저에서 자동 실행되는 것은 아니다.

## 허용 근거

`explanation_worker.facts.extract_basis(state)`는 검증된 현재 `StateSnapshot`을 받아 새 JSON 직렬화 가능 사전을 반환한다. 입력 스냅샷과 리스트를 공유하지 않는다. 네트워크·파일·제어 호출은 없다.

최상위에는 schema_version, run_id, building_id, building_version, guidance_version, basis_generated_at, facts만 포함한다. facts는 아래 ID를 키로 사용한다. 목록은 ID 순으로 정렬하고 실제 경로의 노드 순서는 유지한다.

| 사실 ID | 허용 값 |
| --- | --- |
| `mode` | controller_mode |
| `cause:<source_id>:<hazard_type>` | source_id, hazard_type |
| `blocked-node:<node_id>` | node_id, source_ids, reason_codes |
| `blocked-edge:<edge_id>` | edge_id, source_ids, reason_codes |
| `route:<node_id>` | node_id, next_node_id, exit_id, path_node_ids, cost, reason_codes |

`mode`는 경보가 없는 정상·초기화 상태에도 참조 가능한 현재 제어 모드 근거다. 모든 ID는 같은 실행·건물·안내 버전 안에서만 유효하다. 경로가 없으면 서버의 빈 path·null 출구/비용·reason_codes를 그대로 보존한다. cost는 모델 경로 비용이며 대피 시간이나 안전 보장이 아니다.

영상·confidence·이벤트 ID와 발생 이력·관측 목록·유도등 명령·ACK·단말 상태는 추출하지 않는다. 미래 모델 필드가 늘어도 자동 포함하지 않도록 필드를 명시한다. 따라서 단말 적용 완료나 경보 해제 여부를 이 입력으로 추측해서는 안 된다. 자연어의 한국어 품질·사실성·안전 선언 및 새 행동 지시 여부는 별도 V15 평가 대상이다.

## 검증과 다음 단계

아래는 A05-1 머지 당시의 범위다. 후속 실제 호출/API 구현·검증은 [A05-2](a05-explanation-api.md)에서 확인한다.

`python -m pytest tests/test_explanation_facts.py tests/test_contract.py tests/test_contract_exports.py -q`는 실제 제어기 객체의 정상·화재 우회·양쪽 차단·필수 관측 불가·명시적 해제 후 복구 전이를 사용한다. 사실 선택·수계산 경로·원본 불변성과 기존 명령/ACK가 있는 샘플의 제외 항목을 확인한다. 이는 G01/G02/G04/G07/G09의 **근거 추출 검사**이며 실제 모델 설명 품질이나 V15 완료 증거가 아니다.

이번 단계에는 실행 가능한 worker/API·AWS SDK·Bedrock 호출·서버 배포가 없다. `/api/explanations/current`는 아직 제공하지 않는다. 실제 연결에서 다음을 구현·검증해야 한다.

- 최신 상태 조회와 단일 요청·호출 간격·5초 timeout·512 출력 토큰 상한, 별도 프로세스의 장애 격리.
- 모델의 summary/fact_refs만 수신하고 현재 허용 ID 포함 여부 검사. 실행/건물/안내 버전은 서버가 붙이고 응답 시점에 재검사.
- 설정 TTL(기본 15초)을 **근거 시각부터** 적용하고 오래된 응답 폐기. DTO의 시간 순서 검사만으로 현재 세션 일치·설정 TTL·미래 시각·사실 ID 존재를 보장하지 않는다.
- 실제 모델·프롬프트·입력 근거·요청/응답 시간·토큰·채택/폐기 로그, 실패 시 UNAVAILABLE 및 제어/ACK 계속 동작 확인.
- 관제의 실제 API 연결·서버 시각 기준 만료 검증, 5번 담당자의 독립 문장 평가.

이 단계가 머지되어도 #41은 열린 상태로 유지한다.

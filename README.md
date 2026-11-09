# saferoute

화재 관측에 따라 대피 경로와 유도등 방향을 바꾸는 제어 시스템입니다. 실제 영상 추론·제어 소프트웨어를 개발하고, 3D 건물·연기·가상 설비·브라우저 단말로 검증합니다.

[2026 동북권 개발자 대상 오픈소스 아이디어 경진대회](https://hackathon.tbitcloud.com/northeast-oss)의 지정 주제 **AI 기반 재난 대응 행동요령 안내 서비스**를 건물 화재의 대피 방향 안내로 구체화합니다. 감지는 오픈소스 불꽃·연기 모델, 경로·유도등 판단은 제어 알고리즘, 상황 설명은 Amazon Bedrock이 담당합니다. 설명이 실패해도 제어는 계속 동작하도록 설계합니다. 공식 기준과 주제 대응은 [기획서 0절](docs/01-project-proposal.md#0-공식-대회-기준과-주제-대응)을 참고하세요.

현재 develop에는 공통 계약·제어 API·경로·명령/ACK·시험 도구, 관제·단말·3D 화면, 실제 영상 AI 이벤트·장애 처리·영상별 평가 집계 도구와 별도 Bedrock 설명 API가 반영되어 있습니다. 독립 설명/영상 평가, WFI 전체 통합·지원 서버 배포는 남은 작업입니다. 감지 모델은 개발 후보를 사용하며 최종 채택·프로젝트 라이선스 결정은 A01 #9에서 이어갑니다. 서버 CPU 실측·자체 API 전송 결과와 AV1 실패·샘플 누락·연기 EOF 전 STALE 한계는 [A01-2 기록](docs/ai/a01-server-validation.md)에 있습니다.

## 개발 문서

1. [개발 기획서](docs/01-project-proposal.md)
2. [개발계획서·협업 규칙](docs/02-development-plan.md)
3. [요구사항 명세서](docs/03-requirements-spec.md)
4. [시스템 상세설계서](docs/04-system-design.md)
5. [데이터·인터페이스 명세서](docs/05-data-interface-spec.md)
6. [AI 개발·평가 계획서](docs/06-ai-development-evaluation-plan.md)
7. [통합 시험·시연 시나리오서](docs/07-integration-test-demo-scenarios.md)

지원 서버·S3·Bedrock의 실제 접근 결과와 배포 준비 항목은 [D01 자원 확인 기록](deploy/README.md)에 있습니다.

서버 개발 영상의 FFV1 디코딩 지연·EOF 전 관측 만료는 [A01-3 UTVideo 준비 경로](docs/ai/a01-input-latency.md)에서 두 번의 실제 전송으로 개선을 확인했습니다. 원본 AV1 직접 입력 지원과 전체 배포 완료는 별도입니다.

Bedrock 설명의 별도 계약·허용 근거는 [A05-1](docs/ai/a05-explanation-contract.md), 실제 호출·설명 API·장애 격리·관제 프록시 실행은 [A05-2](docs/ai/a05-explanation-api.md)에 있습니다. 독립 V15 평가와 운영 배포·전체 시연 검수는 남아 있습니다.

CCTV 표시용 프레임·검출 좌표·수명 계약과 합성 샘플은 [A06-1](docs/ai/a06-preview-contract.md)에 있습니다. 실제 미리보기 API·영상 송출·화면 연결은 #73/#74 후속 작업입니다.

## 협업

최신 develop에서 이슈 선택 → `type/번호-작업명` 브랜치 → `type(scope): 변경 내용 (#번호)` 커밋 → push → develop 대상 PR → `ci` 통과 → Squash merge.

예: `feat(ai): 연기 감지 이벤트 추가 (#12)`. 기본 브랜치 develop은 팀 통합용, main은 검증된 시연·배포용입니다. 배포는 `develop → main` PR을 CI 통과 후 Merge commit으로 반영합니다.

두 브랜치 모두 리뷰 승인은 0명이며 직접 push는 금지합니다. 세부 규칙은 [개발계획서 4절](docs/02-development-plan.md#4-팀-협업-규칙), 작성 양식은 [이슈 템플릿](.github/ISSUE_TEMPLATE/task.md)과 [PR 템플릿](.github/pull_request_template.md)을 따릅니다.

## 공통 계약 개발·검사

Python 3.12와 Node 24를 사용합니다. 저장소 루트에서 가상환경을 만들고 활성화한 뒤 설치합니다.

```sh
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-core.lock.txt
npm ci --ignore-scripts
python -m pytest tests -q
python -m tools.export_contracts --check
npm run test:contracts
```

Windows에서는 설치된 Python 3.12로 가상환경을 만들고 `.venv\Scripts\Activate.ps1`로 활성화합니다. AI 환경은 별도로 관리합니다.

담당 1번의 실제 영상→VIDEO_AI 이벤트 실행·설정·로컬 수신 검증은 [A02 연결 기록](docs/ai/a02-video-events.md)을 참고하세요. 서버의 격리된 TWO_ROUTE 전송은 [A01-2](docs/ai/a01-server-validation.md)에서 확인했으며, 최종 모델 선정·WFI 전체 통합·독립 평가는 남아 있습니다.

개발 영상 6개의 출처·파일 해시·사용 조건은 [manifest](data/manifests/assets.json), 실제 CPU 검증·확보/재실행 방법은 [A01 기록](docs/ai/a01-model-validation.md)에 있습니다. 영상·가중치 원본은 Git에 포함하지 않으며 6개 모두 개발용입니다. 5번의 독립 평가 정답과 혼용하지 않습니다.

영상 파일의 EOF·읽기/추론 실패 처리와 추가 실행 환경(ffprobe)은 [A03-1 장애 처리 기록](docs/ai/a03-input-failures.md)에 있습니다.

완료된 AI 실행 한 건의 사건 집계·정답 파일 형식은 [A04-1 평가 도구](docs/ai/a04-event-evaluation.md)에 있습니다. 형식 예제는 독립 평가 정답이 아니며, 실제 평가·목표 판정은 A04에서 별도로 수행합니다.

공통 모델은 [backend/contracts](backend/contracts/), 수락·거부 샘플은 [data/contracts](data/contracts/), 프론트 형식은 [contracts/types.generated.ts](contracts/types.generated.ts)에 있습니다. 모델이나 샘플을 변경하면 `python -m tools.export_contracts`를 실행해 생성 파일도 함께 커밋합니다. TypeScript는 정적 형식 검사이며 브라우저 실행 시 검증은 단말 구현에서 추가합니다. 함수별 사용 기준은 [명세서 10절](docs/05-data-interface-spec.md#10-c02-구현팀-인계-기준)을 참고하세요.

## 백엔드 실행

위 가상환경에서 의존성을 설치한 뒤 저장소 루트에서 실행합니다.

```sh
python -m uvicorn backend.app:create_app --factory --host 127.0.0.1 --port 8000 --workers 1
```

- `http://127.0.0.1:8000/docs`: 관측·제어 요청의 C02 형식과 실행용 API 문서.
- 기본 건물은 계약 시험용 `TWO_ROUTE`입니다. WFI 건물 시연본이 아닙니다.
- `GET /api/session`으로 현재 run_id를 읽고, `GET /api/building`의 관측원 설정에 맞춰 새 이벤트를 `POST /api/events`로 보냅니다.
- 필수 관측원을 확인한 뒤 `POST /api/control/arm`으로 시작합니다. 경보는 정상 관측·영상 종료·시간 만료로 지워지지 않습니다. 운영자가 `clear`로 특정 원인을 해제하거나 `reset`으로 새 실행을 시작합니다.
- 요청이 없어도 100ms 주기의 만료 작업이 실행됩니다. 실제 실행 지연은 OS·로그 기록·잠금 대기에 영향을 받으며 실시간 보장값은 아닙니다.
- 상태·차단·경로·현재 표시면·단말 적용 현황을 `GET /api/state`로 확인합니다. NORMAL은 DEFAULT, EMERGENCY·DEGRADED는 경로에 따라 DYNAMIC 또는 NO_ROUTE, INITIALIZING은 UNKNOWN 표시입니다. DEGRADED는 관측 장애 상태를 유지하면서 필수 관측 불가 구역을 제외한 경로를 안내합니다. 상태 조회만으로 명령을 발행하거나 적용 성공으로 표시하지 않습니다.
- 단말은 `GET /api/signs/{sign_id}/command`로 3초 유효 명령을 받고, 화면에 적용한 뒤 `POST /api/signs/{sign_id}/ack`로 응답합니다. 각 조회는 새 ID·순번을 발행하며 ACK 성공 응답은 해당 `SignState`입니다. [명령·응답 규칙](docs/05-data-interface-spec.md#53-적용-응답)을 따릅니다.
- 실행 증거는 `runs/<run_id>/manifest.json`, `events.jsonl`, `decisions.jsonl`, `commands.jsonl`, `acks.jsonl`에 남고 Git에서 제외됩니다. reset은 이전 기록을 보존합니다.

선택 설정은 `SAFEROUTE_BUILDING_FILE`(검증할 공간 JSON), `SAFEROUTE_RUNS_DIR`(기록 폴더), `SAFEROUTE_OPERATOR_ID`(운영자 기록명)입니다. 운영자 기록명은 사용자 인증이 아닙니다. 현재는 로컬·SSH 터널 내부 접속용이며 단일 worker를 사용합니다. 변경된 공간 설정은 서버를 다시 시작해 적용합니다.

B01 집중 검사: `python -m pytest tests/test_observation_state.py -q`. API 전체와 로그·상태 전이를 함께 확인합니다.

B02 집중 검사: `python -m pytest tests/test_routing.py -q`. G01~G10의 전체 노드 수계산 정답, 독립 경로 열거, 위험 배제·동률·순환·기본 방향 검증을 확인합니다. 경로 비용은 모델 값이며 실제 피난 시간을 의미하지 않습니다.

B03 집중 검사: `python -m pytest tests/test_sign_guidance.py -q`. 정면·반대 면 매핑, 두 sign_id의 상태 분리, 명령 갱신·만료, 변조·역순·중복 ACK, reset·동시 요청·로그 실패를 확인합니다. 시험 클라이언트의 ACK는 실제 브라우저 화면이나 등기구를 관찰한 증거가 아닙니다. P01·I01의 두 화면 연결과 V06 검수는 별도로 수행합니다.

## 관제 없이 연기 시나리오 실행

가상환경을 활성화한 터미널에서 건물·시나리오를 검사합니다. `two-route-smoke.json`은 사람이 읽는 Q02 시험 계획, `two-route-smoke.runtime.json`은 실행 설정입니다.

```sh
python -m tools.validate_config --building data/fixtures/two-route-v1.json --scenario data/scenarios/two-route-smoke.runtime.json
```

1. 위 명령으로 백엔드를 먼저 시작합니다. 재시연이면 이전 실행기를 종료하고 `reset`부터 수행합니다.
2. 별도 터미널에서 아래 실행기를 시작합니다. 초기 관측만 반복 전송하며 운영자의 arm을 기다립니다. 이미 사용 중인 관측원이나 arm된 실행에는 붙지 않습니다.

```sh
python -m scenario_runner --controller-url http://127.0.0.1:8000 --port 8001
python -m tools.control session
python -m tools.control state
```

3. 출력된 run_id를 아래 `RUN_ID` 자리에 직접 넣습니다. 제어 도구는 ID·관측 시각을 새 값으로 자동 교체하지 않습니다. 아래 예제는 실제 실행 ID로 치환한 후 실행합니다.

```sh
python -m tools.control arm --run-id RUN_ID --reason "시연 초기 관측 확인"
```

4. `http://127.0.0.1:8001/sim/state`에서 현재 연기, `http://127.0.0.1:8000/api/state`에서 관측·안내를 별도로 확인합니다. 실행기가 arm을 확인한 시점이 t=0입니다. t=15초 A 연기 증가 → 약 t=17초 우회, t=25초 B 증가 → 약 t=27초 S의 NO_ROUTE입니다. 시간표는 계단식 값이며 실제 연기 물리 모델이 아닙니다. 서버 부하에 따른 지연은 기록에 드러납니다.
5. t=35초 A의 연기가 줄어도 경보는 남습니다. t=40초에 아래처럼 A 원인만 명시적으로 해제하면 A 쪽 안내가 복구됩니다. 실제 안전 확인을 대신하는 자동 해제 기능이 아닙니다.

```sh
python -m tools.control clear --run-id RUN_ID --source-id DETECTOR-A --hazard-type SMOKE --reason "시험 A 구역 확인"
```

6. t=45초 완료 후 입력이 멈추면 관측은 만료됩니다. 실행기를 Ctrl+C로 종료하고 아래 reset으로 새 실행을 시작합니다. 기존 제어 기록은 확정·보존됩니다. 새 시연은 새 실행기를 띄워 진행합니다. 백엔드 정상 종료도 현재 로그를 확정합니다.

```sh
python -m tools.control reset --run-id RUN_ID --reason "다음 시험 준비"
python -m tools.verify_run runs/RUN_ID
```

검증기는 **종료된 실행의 로그 무결성**만 판정하며 `verification.json`을 작성합니다. 실행 중·강제 종료·손상·구형 로그는 FAIL입니다. PASS는 실제 AI·브라우저 표시·실물 유도등 검증을 의미하지 않습니다. 명령·ACK가 없는 실행은 해당 개수가 0으로 기록됩니다. 시나리오 증거는 `runs/<run_id>/simulations/<별도 실행 ID>/`에 분리됩니다.

운영 도구의 다른 서버 접속은 `python -m tools.control --url http://127.0.0.1:8000 state`처럼 지정합니다. 직접 관측 전송은 `python -m tools.control event --file 관측.json`입니다. 설정 검사는 성공 0·오류 2, control은 성공 0·통신/서버 오류 1·입력 오류 2, 로그 검증은 PASS 0·FAIL 1·인자 오류 2를 반환합니다. 실행기는 잘못된 설정이면 2, 기동 실패면 비정상 종료하며 실행 중 오류는 `/sim/state`의 FAILED·error_code로 표시합니다. 실패 후 자동 재연결하지 않습니다.

B04 집중 검사: `python -m pytest tests/test_operating_tools.py tests/test_scenario_runner.py tests/test_audit_lifecycle.py tests/test_run_verification.py -q`. 초기화·지연·누락·역순·손상 로그와 기존 B01/B03의 오래된 입력·ACK 방어를 함께 확인합니다. 실제 화면 검수는 P01·I01에서 수행합니다.

## 협업 규칙 검사

```sh
python3 -m unittest discover -s tests -p 'test_repository_checks.py'
python3 tools/check_repository.py
```

문서·협업 규칙을 검사합니다. CI는 Python 계약 시험과 공통 TypeScript 형식도 확인하며, 웹 앱이 추가되면 프론트 lint·test·build도 요구합니다. 실제 AI·단말·배포 검증은 별도로 수행합니다.

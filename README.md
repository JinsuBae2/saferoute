# saferoute

화재 관측에 따라 대피 경로와 유도등 방향을 바꾸는 제어 시스템입니다. 실제 영상 추론·제어 소프트웨어를 개발하고, 3D 건물·연기·가상 설비·브라우저 단말로 검증합니다.

[2026 동북권 개발자 대상 오픈소스 아이디어 경진대회](https://hackathon.tbitcloud.com/northeast-oss)의 지정 주제 **AI 기반 재난 대응 행동요령 안내 서비스**를 건물 화재의 대피 방향 안내로 구체화합니다. 감지는 오픈소스 불꽃·연기 모델, 경로·유도등 판단은 제어 알고리즘, 상황 설명은 Amazon Bedrock이 담당합니다. 설명이 실패해도 제어는 계속 동작하도록 설계합니다. 공식 기준과 주제 대응은 [기획서 0절](docs/01-project-proposal.md#0-공식-대회-기준과-주제-대응)을 참고하세요.

현재는 C02 공통 데이터 계약, B01 관측 수신·경보 상태 API, B02 위험 배제·다중 출구 경로 계산을 구현한 단계입니다. 유도등 명령·실제 오픈소스 감지 연결·Bedrock 설명(F11/A05)·서버 배포는 후속 작업입니다. 감지 모델의 구체적인 가중치는 실제 실행·사용 조건 확인 후 선정합니다.

## 개발 문서

1. [개발 기획서](docs/01-project-proposal.md)
2. [개발계획서·협업 규칙](docs/02-development-plan.md)
3. [요구사항 명세서](docs/03-requirements-spec.md)
4. [시스템 상세설계서](docs/04-system-design.md)
5. [데이터·인터페이스 명세서](docs/05-data-interface-spec.md)
6. [AI 개발·평가 계획서](docs/06-ai-development-evaluation-plan.md)
7. [통합 시험·시연 시나리오서](docs/07-integration-test-demo-scenarios.md)

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
- 상태·차단 대상·노드별 경로를 `GET /api/state`로 확인합니다. NORMAL에서는 검증된 기본 방향, EMERGENCY에서는 위험 구간을 제외한 경로를 반환합니다. INITIALIZING·DEGRADED에서는 경로를 제공하지 않습니다. 유도등 표시면은 B03 연결 전까지 UNKNOWN/NOT_ISSUED이며 명령을 발행하지 않습니다.
- 실행 증거는 `runs/<run_id>/manifest.json`, `events.jsonl`, `decisions.jsonl`에 남고 Git에서 제외됩니다. reset은 이전 기록을 보존합니다.

선택 설정은 `SAFEROUTE_BUILDING_FILE`(검증할 공간 JSON), `SAFEROUTE_RUNS_DIR`(기록 폴더), `SAFEROUTE_OPERATOR_ID`(운영자 기록명)입니다. 운영자 기록명은 사용자 인증이 아닙니다. 현재는 로컬·SSH 터널 내부 접속용이며 단일 worker를 사용합니다. 변경된 공간 설정은 서버를 다시 시작해 적용합니다.

B01 집중 검사: `python -m pytest tests/test_observation_state.py -q`. API 전체와 로그·상태 전이를 함께 확인합니다.

B02 집중 검사: `python -m pytest tests/test_routing.py -q`. G01~G10의 전체 노드 수계산 정답, 독립 경로 열거, 위험 배제·동률·순환·기본 방향 검증을 확인합니다. 경로 비용은 모델 값이며 실제 피난 시간을 의미하지 않습니다.

## 협업 규칙 검사

```sh
python3 -m unittest discover -s tests -p 'test_repository_checks.py'
python3 tools/check_repository.py
```

문서·협업 규칙을 검사합니다. CI는 Python 계약 시험과 공통 TypeScript 형식도 확인하며, 웹 앱이 추가되면 프론트 lint·test·build도 요구합니다. 실제 AI·단말·배포 검증은 별도로 수행합니다.

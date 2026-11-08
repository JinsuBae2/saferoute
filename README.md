# saferoute

화재 관측에 따라 대피 경로와 유도등 방향을 바꾸는 제어 시스템입니다. 실제 영상 추론·제어 소프트웨어를 개발하고, 3D 건물·연기·가상 설비·브라우저 단말로 검증합니다.

현재는 개발 문서·협업 기반과 C02 공통 데이터 계약을 구현한 단계입니다. API 서버·경로 계산·AI 성능·서버 배포가 완료된 상태는 아닙니다.

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

## 협업 규칙 검사

```sh
python3 -m unittest discover -s tests -p 'test_repository_checks.py'
python3 tools/check_repository.py
```

문서·협업 규칙을 검사합니다. CI는 Python 계약 시험과 공통 TypeScript 형식도 확인하며, 웹 앱이 추가되면 프론트 lint·test·build도 요구합니다. 실제 AI·단말·배포 검증은 별도로 수행합니다.

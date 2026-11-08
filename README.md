# saferoute

화재 관측에 따라 대피 경로와 유도등 방향을 바꾸는 제어 시스템입니다. 실제 영상 추론·제어 소프트웨어를 개발하고, 3D 건물·연기·가상 설비·브라우저 단말로 검증합니다.

현재는 개발 문서와 협업·CI 기반을 준비한 단계입니다. 제품 기능·AI 성능·서버 배포가 완료된 상태는 아닙니다.

## 개발 문서

1. [개발 기획서](docs/01-project-proposal.md)
2. [개발계획서·협업 규칙](docs/02-development-plan.md)
3. [요구사항 명세서](docs/03-requirements-spec.md)
4. [시스템 상세설계서](docs/04-system-design.md)
5. [데이터·인터페이스 명세서](docs/05-data-interface-spec.md)
6. [AI 개발·평가 계획서](docs/06-ai-development-evaluation-plan.md)
7. [통합 시험·시연 시나리오서](docs/07-integration-test-demo-scenarios.md)

## 협업

이슈 선택 → `type/번호-작업명` 브랜치 → `type: 변경 내용 (#번호)` 커밋 → push → PR → `ci` 통과 → Squash merge.

리뷰 승인은 필수가 아닙니다. main 직접 push는 저장소 초기화 이후 금지합니다. 세부 규칙은 [개발계획서 4절](docs/02-development-plan.md#4-팀-협업-규칙), 작성 양식은 [이슈 템플릿](.github/ISSUE_TEMPLATE/task.md)과 [PR 템플릿](.github/pull_request_template.md)을 따릅니다.

## 현재 검사

```sh
python3 -m unittest discover -s tests -p 'test_repository_checks.py'
python3 tools/check_repository.py
```

문서·협업 규칙을 검사합니다. 제품 코드가 추가되면 CI가 백엔드 시험과 프론트 lint·test·build도 요구합니다. 실제 AI·단말·배포 검증은 별도로 수행합니다.

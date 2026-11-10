# SafeRoute 출처·라이선스

Copyright (C) 2026 SafeRoute contributors.

팀이 작성한 SafeRoute 코드는 GNU Affero General Public License version 3 only
(`AGPL-3.0-only`)로 제공합니다. 전문은 [LICENSE](LICENSE)에 있습니다. 보증 없이
제공하며, 복제·수정·배포 시 해당 조건과 저작권 고지를 유지합니다.
선정 근거는 [담당 1 결정 기록](docs/ai/a01-selection-acceptance.md)을 따릅니다.
제3자 코드·가중치·영상·공간 원자료의 저작권과 개별 조건은 그대로 유지됩니다.
팀 코드의 라이선스 선택으로 제3자 자료에 새 권한을 부여하지 않습니다.

| 구분 | 출처와 조건 확인 위치 |
|---|---|
| 선정 가중치 | [xiazh0219 고정 모델 카드](https://huggingface.co/xiazh0219/yolo26m-UAV-fire-smoke-detection/blob/57cf971a788fff62b8f3e5b1c3632e1214b8255c/README.md), 게시자 AGPL-3.0 표기. [출처·해시 기록](docs/ai/a01-alternative-models.md) |
| 추론 런타임 | [Ultralytics AGPL 조건](https://www.ultralytics.com/license), [AI lock](requirements-ai.lock.txt). PyTorch·NumPy·OpenCV 등은 해당 배포물의 별도 라이선스·고지 유지 |
| 백엔드·웹 의존성 | [백엔드 lock](requirements-core.lock.txt), [웹 lock](web/package-lock.json). 각 패키지의 저작권·라이선스 고지 보존 |
| 영상 | [manifest](data/manifests/assets.json), [자료 인계](docs/ai/evaluation-freeze-and-handoff.md)의 원출처·파일별 조건 유지. 원본 파일은 Git에 포함하지 않음 |
| 공간 자료 | [공간 자료](data/space)의 원출처·가정·수정 기록 유지. 팀 코드의 라이선스를 원자료에 적용하지 않음 |

학습 자료의 모든 원천 권리와 학습/평가 중복은 확인되지 않았습니다. 게시자의 조건을
전체 데이터 권리 보증으로 해석하지 않습니다. 별도 조건이 있는 영상·가중치를 임의로
묶어 재배포하지 않습니다. 해당 배포 방식이 요구하는 대응 소스·가중치 제공을 충족할 수
없으면 그 배포는 진행하지 않습니다.

네트워크 이용자는 화면 하단 **소스 코드**에서 빌드 커밋의 전체 저장소를 확인하고
**라이선스**에서 전문을 확인할 수 있습니다. 소스에는 코드, 실행·빌드 설정, 의존성 lock,
모델 확보 방법과 재현 기록이 포함됩니다. 배포자는 실제 서버/웹 버전과 제공 소스가
일치하는지 [배포 안내](deploy/README.md)에 따라 확인해야 합니다. 운영 배포 완료나
모든 제3자 권리의 검증을 선언하는 문서는 아닙니다.

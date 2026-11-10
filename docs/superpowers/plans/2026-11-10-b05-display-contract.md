# B05 표시 데이터 연결 Implementation Plan

> 실행: 현재 세션에서 코드 → 시험 → 자체 검토 → 수정 순서로 진행한다.

**Goal:** #67의 위치·표지 표시 메타데이터와 기존 경로·시험 제어 연결 기준을 제공한다.
**Architecture:** Building과 분리된 BuildingDisplay 자료를 정적 자산으로 배포한다. 제어 API·경로 계산·명령/ACK는 기존 계약을 유지한다.
**Tech Stack:** 기존 Python/Pydantic 검증, 생성 TypeScript, pytest.
**Spec:** https://github.com/JinsuBae2/saferoute/issues/67

## 제약과 결정
- 기존 건물 ID·버전·좌표·경로 정책을 변경하지 않는다.
- 위치 표시 자료는 같은 건물의 전체 ID를 참조하며 알 수 없는 설치 위치는 null이다.
- 출구 위치 표지와 제어 유도등은 각각 exit_labels와 signs로 구분한다.
- 목록 선택·비교 경로는 화면 상태이며 제어 입력이 아니다.
- 기존 작업 파일은 별도 작업 공간에 보존한다. 담당3·4의 화면 구현은 이 이슈에 포함하지 않는다.

## Task 1: 표시 계약과 검증
- [x] BuildingDisplay 수락·거부·참조·버전·설치 위치·표지 종류 시험 작성 및 실패 확인.
- [x] backend/contracts/display.py, validation.py에 최소 계약과 validate_for(Building) 구현.
- [x] valid/rejected 샘플과 생성 TypeScript를 갱신하고 관련 시험 통과.

## Task 2: 검증 도구와 인계
- [x] validate_config --display로 잘못된 참조/버전을 거부하는 시험 및 구현.
- [x] 기존 StateSnapshot·Route·SignState·제어 API 샘플과 MANUAL_TEST 제약을 문서화.
- [x] 변경 계약 전체 검사, TypeScript, 저장소 규칙, 영향 회귀를 수행.

## Review Focus
- 다른 건물/버전과 누락·추가 ID를 허용하지 않는다.
- 카메라 설치 위치와 관측 구역을 동일하다고 가정하지 않는다.
- 출구 위치 표시는 경로 안전·단말 ACK를 대신하지 않는다.
- WFI v3에는 MANUAL_TEST가 없으므로 기존 VIDEO_AI를 시험 화재로 가장하지 않는다.
- 화면 선택은 설치 유도등 명령에 영향을 주지 않는다.

## 검토 결과

표시 자료의 전체 참조·건물 버전·실측/가상 위치·출구 표시면을 검토했다. 제어 API·원본 건물·경로와 ACK 정책 변경은 없다. Python 739개와 프론트 83개, TypeScript·lint·build 통과. 기존 Starlette 경고와 로컬 Node 20.12의 Vite 권장 버전 경고는 남으며 GitHub CI의 Node 24 결과를 별도로 확인한다. #68·#72는 각각 후속 브랜치/PR에서 처리하고 #28 배포는 제외한다.

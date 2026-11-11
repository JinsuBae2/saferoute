# First-person Phone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** 손에 든 휴대폰에서 서버 대피 안내와 움직이는 미니맵을 확인하는 로컬 체험.
**Architecture:** BuildingScene의 인물 위치 콜백을 UI에 공유하고 PhoneGuide가 최신 서버 경로를 표시한다. 순수 phoneGuide 함수가 경로 상태와 1인칭 인물 선택을 결정한다.
**Tech Stack:** 기존 React, TypeScript, Three.js, SVG, CSS. 런타임 의존성 추가 없음.
**Spec:** docs/superpowers/specs/2026-11-11-first-person-phone.md

## Global Constraints
- 로컬 브랜치만 수정. 서버 경로와 사람 이동 정책은 변경하지 않는다.
- 음소거로 화면 검증. QR은 장면 기반 인식 연출이라고 표시.

## Review Focus
- 오래된 상태 또는 새 실행에서 이전 경로·QR 확인을 표시하지 않는다.
- 같은 평면 좌표의 다른 층 사람·QR을 선택하지 않는다.
- 되돌아가는 사람과 계단 이동에서도 실제 이동과 안내가 모순되지 않는다.
- 휴대폰 열기·닫기·QR 조작은 이동과 기존 출구 음성을 끊지 않는다.
- 작은 화면에서도 방향 문장과 닫기 버튼을 읽고 누를 수 있다.

## Task 1: 안내·인물 선택
- [x] web/src/building/phoneGuide.test.ts: 선택 층·탈출 제외, 최신/차단/끊김/새 실행/계단/되돌아감 검증을 먼저 작성하고 실패 확인.
- [x] phoneGuide.ts: FollowPose, nearestPerson, phoneGuidance, nearbyQr 순수 함수 구현. 기존 describeJourney 재사용.
- [x] 가까운 시험 및 타입 검사.

## Task 2: 손·휴대폰·QR
- [x] EvacuationPhone.tsx, phone.css: SVG 손, 휴대폰, 층별 SVG 미니맵, 열기/닫기와 QR 확인 연출.
- [x] BuildingPanel.tsx, BuildingScene.tsx: 선택 위치 진입과 실제 인물 pose 연결, 기존 유도등 옆 QR 판.
- [x] QR 이미지는 위치 식별 문자열을 담은 정적 PNG로 생성. 서버·사용자 자격 정보 없음.

## Task 3: 검증
- [x] 프론트 시험·타입·lint. 통과 뒤 로컬 커밋과 빌드(저장소 빌드 규칙).
- [x] 별도 포트 서버를 켜고 실제 1인칭·QR·이동·계단·차단·복구·작은 화면 확인.
- [x] 독립 검토에서 발견한 실제 결함만 수정. 로컬 접속 주소와 확인한 한계를 보고.

## 검증 기록
- 최신 기준: origin/develop 7529574. 원래 작업 폴더와 지연 브랜치 보존.
- 프론트 251개 시험 통과. 타입·lint 통과.
- 실제 브라우저: 301호 선택 → 3층 1인칭, 화재 후 경로 변경, QR 확인 중 계속 이동, 3층→2층→1층 안내, 휴대폰 닫기/열기, 차단 시 경로선 0개, 해제 뒤 계속 이동, QR 없이 전원 23명 탈출.
- 390px 화면에서 휴대폰·미니맵·닫기 버튼 확인.
- 독립 검토의 QR 텍스처 정리 누락과 계단 되돌기 층 오류 수정. 계단 되돌기 시험 수정 전 실패→수정 후 통과.
- 생성 QR 43개 모두 macOS Vision으로 위치 문자열 디코딩 확인. 실제 카메라 앱 연동 아님.
- 서버 코드 변경 없음. 서버 시험·실제 청취 생략. 통신 끊김 및 계단 되돌기는 자동 시험으로 확인.

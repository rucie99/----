# 경기산업 기성집행서

아마란스10 프로젝트와 품목별 입고금액을 바탕으로 프로젝트별 실행예산, 매입금액, 예상 이익과 이익률을 관리하는 사내용 웹 프로그램입니다.

## 구현 범위

- 대분류, 중분류, 중분류별 품번 설정
- 아마란스10 품번 검색 및 프로젝트 동기화
- 아마란스10 callerName, accessToken, hashKey, 그룹시퀀스 저장 화면
- 매 요청별 transaction-id, timestamp, wehago-sign 인증 헤더 생성
- 프로젝트별 분류/품번 스냅샷 생성
- 이전 버전 복제와 확정 버전 잠금
- 실행예산 및 비고 상단 일괄 저장, Enter 입력 이동, 금액 천 단위 표시
- 품목별 입고 공급가액 불러오기와 중복 방지
- 입고 헤더 `/apiproxy/api20A02S00201`와 디테일 `/apiproxy/api20A02S00202` 연계 조회
- 계약금액 대비 예상 이익 및 이익률 계산
- 대분류 병합, 대분류별 중분류 소계 및 소계 집행률 표시
- 연결 품번을 상세 코드 대신 품번 건수로 요약 표시
- A4 가로 기성집행서 인쇄와 Excel 보고서 내보내기
- SQLite 데이터 저장과 Windows 시작 시 자동 실행

## 개발 실행

Node.js 22.5 이상에서 다음 명령을 실행합니다.

```powershell
node src/server.mjs
```

브라우저에서 `http://localhost:5080`을 엽니다. 기본 설정은 `DEMO` 모드이며 별도 계정 없이 전체 흐름을 시험할 수 있습니다.

## 검증

```powershell
node --test
node scripts/check-utf8.mjs
```

Windows 배포 패키지는 다음 명령으로 생성합니다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-windows.ps1
```

운영 설치와 아마란스10 설정은 [DEPLOYMENT.md](DEPLOYMENT.md)를 참고하세요.

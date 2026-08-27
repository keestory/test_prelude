# PRELUDE 재고·발주관리

PRELUDE의 재고, SKU, 발주처, Google Sheets 발주 양식을 한 화면에서 관리하는 웹 프로토타입입니다.

## 실행

Node.js 24 이상에서 다음 명령으로 로컬 실행합니다.

```bash
node server.mjs
```

브라우저에서 `http://127.0.0.1:4173/index.html`을 엽니다.

## 검증

```bash
node --check server.mjs
node --test tests/*.test.mjs
```

## 배포 구조

- 프런트엔드: GitHub Pages
- Google Sheets 검사와 XLSX 프록시: Supabase Edge Function `google-sheets`
- 운영 데이터: Supabase Postgres의 `prelude_workspaces` JSONB snapshot (Supabase Auth + RLS)
- 로컬 전용 파일: 원본 XLSX template bytes는 IndexedDB에 보관

현재 publishable key는 브라우저에서 사용할 수 있는 공개 키입니다. Supabase secret 또는 service-role key를 소스에 추가하지 마세요.

앱은 사전에 등록한 운영자 이메일·비밀번호로 Supabase Auth 세션을 만든 뒤 상품·SKU·재고·입출고·발주·발주처 metadata를 사용자별 작업공간에 저장합니다. 공개 회원가입은 제공하지 않습니다. 첫 로그인에서 원격 작업공간이 비어 있으면 삭제 요청을 반영한 빈 상품·SKU·재고·발주 상태로 시작하되 발주처·양식 연결 metadata는 유지하며, 이후에는 Supabase revision을 기준으로 충돌을 차단합니다.

Supabase Auth의 Site URL과 Redirect URL에는 `https://test-prelude.vercel.app/`을 등록해야 합니다.

GitHub Pages는 `main` 브랜치가 갱신될 때 `.github/workflows/pages.yml`을 통해 테스트 후 자동 배포됩니다.

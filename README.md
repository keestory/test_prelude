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
- 브라우저 업무 데이터: IndexedDB와 localStorage

현재 publishable key는 브라우저에서 사용할 수 있는 공개 키입니다. Supabase secret 또는 service-role key를 소스에 추가하지 마세요.

GitHub Pages는 `main` 브랜치가 갱신될 때 `.github/workflows/pages.yml`을 통해 테스트 후 자동 배포됩니다.


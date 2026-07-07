# AlphaMark SaaS Dashboard — Prototype

This is a lightweight, standalone prototype of the brand-scoped SaaS dashboard.

How to open (recommended — run with backend):

1. Start the backend server from the `alphamark-backend` folder:

```powershell
npm install
npm run dev
```

2. Open the dashboard page and provide a brand API key as a query parameter (or set `x-api-key` header in your requests):

https://localhost:3000/api/dashboard/page?api_key=YOUR_BRAND_API_KEY

The frontend will store the API key in `localStorage` for subsequent API calls.

Note: If you want to preview without the server, open `index.html` directly but the data will be static/sample only.

Notes:
- This is a frontend prototype only — integrate your backend APIs for real data.
- Use the `Sync Products` and `Regenerate Metadata` buttons to wire up actual endpoints.

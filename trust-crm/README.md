# trust-crm

## Setup

```bash
npm install
node server.js
```

## Environment

Create a `.env` with:

```env
PORT=5000
DB_HOST=localhost
DB_USER=postgres
DB_PASSWORD=yourpassword
DB_NAME=trustcrm
DB_PORT=5432
```

## Database

```sql
CREATE TABLE candidates (
    id SERIAL PRIMARY KEY,
    full_name TEXT,
    nationality TEXT,
    date_of_birth DATE,
    passport_number TEXT,
    passport_expiry DATE,
    b3_expiry DATE,
    embassy_date DATE,
    visa_status TEXT,
    work_company TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Routes

- `POST http://localhost:5000/candidates/add`
- `GET  http://localhost:5000/candidates/all`
- `GET  http://localhost:5000/alerts/expiring`
- `POST http://localhost:5000/auth/login`

# trust-crm

Backend API for candidate onboarding, role-based access, and expiry notifications.

## Setup

```bash
npm install
npm start
```

## Environment

Create `.env`:

```env
PORT=5000
DB_HOST=localhost
DB_USER=postgres
DB_PASSWORD=yourpassword
DB_NAME=trustcrm
DB_PORT=5432
JWT_SECRET=trustcrmsecretkey
```

## Database

```sql
CREATE TABLE IF NOT EXISTS candidates (
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
  partner_company TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  full_name TEXT,
  email TEXT UNIQUE,
  password TEXT,
  role TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  candidate_id INT REFERENCES candidates(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  due_date DATE,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_notif
ON notifications(candidate_id, type, due_date);
```

## Main routes

- `POST /auth/register`
- `POST /auth/login`
- `POST /candidates/add` (token + role: Admin/Manager/Receptionist)
- `GET /candidates/all` (token + role: Admin/Manager/Receptionist/Accountant/HR)
- `GET /alerts/expiring`
- `GET /notifications/latest` (token + role: Admin/Manager/Receptionist/Accountant/HR)
- `POST /notifications/read/:id` (token + role: Admin/Manager/Receptionist/Accountant/HR)

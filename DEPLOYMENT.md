# TaskFlow Pro Deployment Guide

## 1. Backend Deployment (Render)
- **Service Type**: Web Service
- **Build Command**: `npm install`
- **Start Command**: `node src/server.js`
- **Environment Variables**:
  - `PORT`: `5000`
  - `JWT_SECRET`: `<your_secret>`
  - `GEMINI_API_KEY`: `<your_gemini_api_key>`
  - `DATABASE_URL`: `postgresql://<user>:<password>@<aws_rds_endpoint>:5432/taskflowpro` (Optional, defaults to in-memory PG store for instant demo)

## 2. Database Deployment (AWS RDS PostgreSQL)
- Create PostgreSQL 15+ database instance on AWS RDS.
- Run `backend/src/db/schema.sql` to initialize tables: `users`, `projects`, `tasks`, `task_dependencies`, `dependency_patterns`, `ai_suggestions`.

## 3. Frontend Deployment (Vercel)
- **Framework Preset**: Vite
- **Build Command**: `npm run build`
- **Output Directory**: `dist`
- Configure rewrite proxy in `vercel.json` pointing `/api/(.*)` to Render backend URL.

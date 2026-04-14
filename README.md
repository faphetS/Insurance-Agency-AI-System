# Fullstack Boilerplate (React + Node + Express)

A ready-to-go fullstack boilerplate for starting new projects with React (frontend) and Node + Express (backend), both supported by TypeScript and fully connected.

## Features

### Frontend Stack
- React
- Vite
- TypeScript
- Tailwind
- Axios
- React Router DOM

### Backend Stack
- Node
- Express
- TypeScript
- Cors
- Dotenv
- Nodemon

### Folder Structure
- `client/` → contains React frontend app  
- `server/` → contains Node + Express backend app  

---

## Getting Started

### 1. Create a new repository from this template
1. Go to this repository on GitHub.  
2. Click the **“Use this template”** button.  
3. Select **“Create a new repository”**.  
4. Give your new repo a **name** and choose **public or private**.  
5. Click **“Create repository from template”**.  

> ✅ This creates a **fresh repository** with all files from the boilerplate, a clean git history, and **no connection** to the original repo.

### 2. Clone your new project locally
1. Go to your newly created repository on GitHub.  
2. Click the **Code** button and copy the **HTTPS URL**.  
3. Run the following commands in your terminal, replacing `<YOUR_REPO_URL>` with the URL you copied:

```bash
git clone <YOUR_REPO_URL>
cd YOUR_NEW_PROJECT
```

### 3. Install dependencies  
```bash
cd server
npm install

cd ../client
npm install
```

### 4. Start development servers
```bash
cd client
npm run dev

cd server
npm run dev
```

---

## Optional: Check and Update Dependencies

### Check for outdated packages
```bash
cd client   # or cd server
npx npm-check-updates
```
- Shows available updates for dependencies and devDependencies
- Does not modify your project

### Update dependencies
```bash
cd client   # or cd server
npx npm-check-updates -u
npm install
```
- Updates package.json to the latest versions and installs them
- Always test your project after updating dependencies
- Recommended: do updates in a separate branch to keep your main branch stable

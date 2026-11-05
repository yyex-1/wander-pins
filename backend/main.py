import os
from dotenv import load_dotenv
from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from passlib.context import CryptContext
from jose import JWTError, jwt
from supabase import create_client, Client

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
JWT_SECRET = os.getenv("JWT_SECRET")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM","HS256")
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

app = FastAPI(title="Wander‑Pins Api")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:8000",
        "http://127.0.0.1:8138",
        FRONTEND_ORIGIN
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class RegisterReq(BaseModel):
    username: str
    password: str

class LoginReq(BaseModel):
    username: str
    password: str

@app.post("/api/v1/auth/register")
async def register(req: RegisterReq):
    res = supabase.table("users").select("id").eq("username",req.username).execute()
    if res.data:
        raise HTTPException(status_code=409,detail="该用户名已经被注册")
    pwd_bytes = req.password.encode("utf-8")[:72]
    pwd_truncated = pwd_bytes.decode("utf-8", errors="ignore")
    hashed_password = pwd_context.hash(pwd_truncated)
    insert_res = supabase.table("users").insert({
        "username":req.username,
        "password_hash":hashed_password
    }).execute()
    user = insert_res.data[0]
    return {"ok":True,"user_id":user["id"],"username":user["username"]}

@app.post("/api/v1/auth/login")
async def login(req: LoginReq):
    res = supabase.table("users").select("id,password_hash").eq("username",req.username).execute()
    if not res.data:
        raise HTTPException(status_code=401,detail="用户名或密码错误")
    user = res.data[0]
    pwd_bytes = req.password.encode("utf-8")[:72]
    pwd_truncated = pwd_bytes.decode("utf-8", errors="ignore")
    if not pwd_context.verify(pwd_truncated, user["password_hash"]):
        raise HTTPException(status_code=401,detail="用户名或密码错误")
    token_data={"sub":user["id"]}
    token = jwt.encode(token_data,JWT_SECRET,algorithm=JWT_ALGORITHM)
    return {"access_token":token,"username":req.username,"user_id":user["id"]}

@app.get("/api/v1/auth/me")
async def get_me(token:str):
    try:
        payload = jwt.decode(token,JWT_SECRET,algorithms=[JWT_ALGORITHM])
        uid = payload.get("sub")
        if not uid: raise Exception()
        u = supabase.table("users").select("id,username").eq("id",uid).execute()
        return u.data[0]
    except JWTError:
        raise HTTPException(status_code=401,detail="token无效")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app",host="0.0.0.0",port=8000)

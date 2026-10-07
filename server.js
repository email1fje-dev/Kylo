import express from "express";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({limit:"2mb"}));
app.use(express.static(path.join(__dirname,"public")));

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminPassword = process.env.ADMIN_PASSWORD;

const db = url && key ? createClient(url,key,{auth:{persistSession:false}}) : null;

function auth(req,res,next){
  const token = req.headers.authorization?.replace("Bearer ","");
  if(!adminPassword || token !== adminPassword) return res.status(401).json({error:"Unauthorized"});
  next();
}

app.get("/api/projects", async (_req,res)=>{
  if(!db) return res.json([]);
  const {data,error}=await db.from("projects").select("*").order("featured",{ascending:false}).order("created_at",{ascending:false});
  if(error) return res.status(500).json({error:error.message});
  res.json(data);
});

app.post("/api/projects",auth,async(req,res)=>{
  if(!db) return res.status(500).json({error:"Supabase is not configured"});
  const {data,error}=await db.from("projects").insert([req.body]).select().single();
  if(error) return res.status(400).json({error:error.message});
  res.json(data);
});

app.put("/api/projects/:id",auth,async(req,res)=>{
  if(!db) return res.status(500).json({error:"Supabase is not configured"});
  const {data,error}=await db.from("projects").update(req.body).eq("id",req.params.id).select().single();
  if(error) return res.status(400).json({error:error.message});
  res.json(data);
});

app.delete("/api/projects/:id",auth,async(req,res)=>{
  if(!db) return res.status(500).json({error:"Supabase is not configured"});
  const {error}=await db.from("projects").delete().eq("id",req.params.id);
  if(error) return res.status(400).json({error:error.message});
  res.json({ok:true});
});

app.get("/admin",(req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

const port=process.env.PORT||3000;
app.listen(port,()=>console.log("Kylo running on "+port));

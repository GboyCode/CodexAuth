const fs = require("node:fs/promises");
const path = require("node:path");

function validIndex(value) {
  return !!value && typeof value === "object" && Array.isArray(value.accounts) &&
    value.accounts.every((a)=>a && typeof a.id === "string" && /^[a-f0-9-]{36}$/i.test(a.id) && a.identity && typeof a.identity === "object");
}

async function recoverAccountIndex({indexPath,accountsDir,extension,decode,identify,makeRecord,write}) {
  let raw=null;
  try { raw=await fs.readFile(indexPath,"utf8"); const parsed=JSON.parse(raw);if(validIndex(parsed)) return {index:parsed,recovered:false}; }
  catch(error) {if(error.code && error.code!=="ENOENT") throw error;}
  const names=(await fs.readdir(accountsDir)).filter((name)=>new RegExp(`^[a-f0-9-]{36}\\.${extension}$`,"i").test(name));
  if (raw===null && !names.length) return {index:null,recovered:false};
  // Preserve both broken metadata and an independent encrypted-snapshot copy.
  // Recovery is repeatable; a failed decode never deletes an account blob.
  const recoveryDir=path.join(path.dirname(indexPath),`recovery-${Date.now()}`);
  await fs.mkdir(recoveryDir,{recursive:true});
  if(raw!==null)await fs.writeFile(path.join(recoveryDir,"accounts.corrupt.json"),raw,{mode:0o600});
  const accounts=[],identities=new Set();let skipped=0;
  for(const name of names){
    const filename=path.join(accountsDir,name);
    await fs.copyFile(filename,path.join(recoveryDir,name));
    try{
      const auth=await decode(await fs.readFile(filename,"utf8"));
      const key=identify(auth.identity);if(!key||identities.has(key)){skipped++;continue;}
      const record=makeRecord(auth);record.id=path.basename(name,`.${extension}`);accounts.push(record);identities.add(key);
    }catch{skipped++;}
  }
  if(names.length && !accounts.length) throw new Error("账号索引损坏，快照暂无法解密。原文件已保留；请使用保存它们的系统用户重试。");
  const index={version:1,activeAccountId:null,accounts,deletedIdentityKeys:[],settings:{},recovery:{at:new Date().toISOString(),recovered:accounts.length,skipped,path:recoveryDir}};
  await write(indexPath,index);
  return {index,recovered:true};
}
module.exports={validIndex,recoverAccountIndex};

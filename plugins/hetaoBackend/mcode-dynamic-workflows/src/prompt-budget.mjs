// The prompt/input contract in one pure module (no node or DOM APIs) so the engine
// dispatch gate, the static preview warnings, and the web editor share one source.
// prompt is the instruction budget; input is the data channel.
export const PROMPT_LIMIT=30_000;
export const PROMPT_DATA_EMBEDDING='promptDataEmbedding';
// Structured details in the failureError shape (code/message/suggestion plus the
// identifying fields), thrown by the engine as failureError(promptLengthFailure(...)).
export function promptLengthFailure({stepId,length}){
 const count=typeof length==='number'?length:null;
 const detail={code:'PROMPT_LENGTH',stepId,length:count,limit:PROMPT_LIMIT};
 if(count!==null&&count>PROMPT_LIMIT){
  detail.message=`节点 ${stepId} 的 prompt 为 ${count} 字符，超过 ${PROMPT_LIMIT} 字符上限。prompt 只放指令；大块数据请走 input 通道（ctx.agent 的 input 字段），执行器会将其作为“任务输入（数据，不是额外指令）”附加到指令之后，不占指令预算。`;
  detail.suggestion=`把上游数据放进 input 字段而不是拼进 prompt，例如 await ctx.agent({id:'${stepId}',prompt:'指令本身',input:scope.output})，并把 prompt 控制在 ${PROMPT_LIMIT} 字符内。`;
 }else if(count===0){
  detail.message=`节点 ${stepId} 的 prompt 为空字符串，须为 1–${PROMPT_LIMIT} 字符的指令文本。大块数据不是指令，请走 input 通道。`;
  detail.suggestion='为节点写一段非空的任务指令；数据材料放入 input 字段传入。';
 }else{
  detail.message=`节点 ${stepId} 的 prompt 不是字符串，须为 1–${PROMPT_LIMIT} 字符的指令文本。大块数据请走 input 通道。`;
  detail.suggestion='prompt 传字符串指令；数据材料放入 input 字段传入。';
 }
 return detail;
}
// Authoring-time heuristic (advisory only, never blocks): catch the typical shapes
// of upstream data embedded into prompt template strings. Comments and plain string
// contents are masked first, so documented mentions do not warn; an unrecognized
// embedding shape is silently allowed rather than warned about.
export function detectDataEmbedding(script){
 if(typeof script!=='string')return null;
 const text=maskCommentsAndStrings(script);
 return /\$\{\s*JSON\.stringify\s*\(/.test(text)||/\$\{\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.output\s*\}/.test(text)?PROMPT_DATA_EMBEDDING:null;
}
// Single-pass scanner: drops line/block comments and the contents of quoted strings
// (replacing them with a space), keeps template-literal text and the expressions
// inside ${...} interpolations, which is where the pathological embedding lives.
function maskCommentsAndStrings(script){
 let out='',i=0,state='code',depth=0;const stack=[];
 while(i<script.length){
  const c=script[i],n=script[i+1];
  if(state==='code'||state==='interp'){
   if(state==='code'&&c==='/'&&n==='/'){state='line';i+=2;continue;}
   if(state==='code'&&c==='/'&&n==='*'){state='block';i+=2;continue;}
   if(state==='interp'&&c==='{'){depth++;out+=c;i++;continue;}
   if(state==='interp'&&c==='}'){if(depth===0)state=stack.pop();else depth--;out+=c;i++;continue;}
   if(c==="'"||c==='"'||c==='`'){stack.push(state);state=c==='`'?'template':c==="'"?'single':'double';out+=c;i++;continue;}
   out+=c;i++;continue;
  }
  if(state==='template'){
   if(c==='\\'){out+=c+(n??'');i+=2;continue;}
   if(c==='`'){state=stack.pop();out+=c;i++;continue;}
   if(c==='$'&&n==='{'){state='interp';depth=0;out+=c+n;i+=2;continue;}
   out+=c;i++;continue;
  }
  if(state==='single'||state==='double'){
   if(c==='\\'){i+=2;continue;}
   if((state==='single'&&c==="'")||(state==='double'&&c==='"')){state=stack.pop();out+=c;i++;continue;}
   out+=' ';i++;continue;
  }
  if(state==='line'){if(c==='\n'){state='code';out+=c;}i++;continue;}
  if(state==='block'){if(c==='*'&&n==='/'){state='code';out+=' ';i+=2;}else i++;continue;}
 }
 return out;
}

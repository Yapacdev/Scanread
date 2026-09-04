import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.54/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.54/pdf.worker.min.mjs";

const $=id=>document.getElementById(id);
let pdf=null, pageNum=1, scale=1, bookKey=null, state=null, currentText="", voices=[];
let speechQueue=[], speechIndex=0, speaking=false;
let userPickedVoice=false;

// Prefer higher-quality voice engines (Google/Natural/Neural) over robotic-sounding system defaults.
function voiceQuality(v){
 const n=v.name.toLowerCase();
 if(n.includes("natural")||n.includes("neural")||n.includes("google")||n.includes("online"))return 3;
 if(n.includes("premium")||n.includes("enhanced")||n.includes("plus"))return 2;
 if(n.includes("desktop")||n.includes("compact")||n.includes("espeak")||n.includes("mobile"))return 0;
 return 1;
}
function pickVoiceIndex(langCode){
 if(!voices.length)return -1;
 const matches=voices.map((v,i)=>({v,i})).filter(o=>o.v.lang.toLowerCase().startsWith(langCode));
 const pool=matches.length?matches:voices.map((v,i)=>({v,i}));
 pool.sort((a,b)=>voiceQuality(b.v)-voiceQuality(a.v));
 return pool[0].i;
}
function applyDefaultVoice(){
 if(!hasEnglishSystemVoice())ensureFallbackVoice(); // download a bundled English voice if the system has none
 if(userPickedVoice||!voices.length)return;
 const idx=pickVoiceIndex("en");
 if(idx>=0)$("voiceSelect").value=idx;
}
function hasEnglishSystemVoice(){return voices.some(v=>v.lang.toLowerCase().startsWith("en"))}

// --- Offline English fallback voice ---
// Only used when the OS/browser genuinely has no English voice at all. Loads a small,
// self-contained eSpeak-based engine (mespeak.js) so English reading works with zero
// install and no dependency on system voices. Robotic-sounding, but always available.
let fallbackReady=false, fallbackLoading=false;
const MESPEAK_BASE="https://cdn.jsdelivr.net/gh/btopro/mespeak@master/";
function withTimeout(promise,ms,msg){
 return Promise.race([promise,new Promise((_,rej)=>setTimeout(()=>rej(new Error(msg||"Timed out")),ms))]);
}
function loadScript(src){
 return new Promise((res,rej)=>{
  const s=document.createElement("script");
  s.src=src;s.onload=()=>res();s.onerror=()=>rej(new Error("Failed to load "+src));
  document.head.appendChild(s);
 });
}
async function ensureFallbackVoice(){
 if(fallbackReady||fallbackLoading)return;
 fallbackLoading=true;
 try{
  await withTimeout(loadScript(MESPEAK_BASE+"mespeak.js"),10000,"Offline voice engine failed to load");
  await withTimeout(new Promise((res,rej)=>{
   window.meSpeak.loadConfig(MESPEAK_BASE+"mespeak_config.json",()=>res());
   setTimeout(()=>rej(new Error("Config load timed out")),9000);
  }),9500);
  await withTimeout(new Promise((res,rej)=>{
   window.meSpeak.loadVoice(MESPEAK_BASE+"voices/en/en-us.json",(ok,info)=>ok?res():rej(new Error(info||"Voice load failed")));
  }),9500);
  fallbackReady=true;
  $("speechStatus").textContent="Using a built-in offline English voice (no English system voice was found).";
 }catch(err){
  console.warn("Offline English voice unavailable:",err);
 }finally{fallbackLoading=false}
}
function useFallbackTTS(){return fallbackReady&&!userPickedVoice&&!hasEnglishSystemVoice()}

const storage={
 get(k){try{return JSON.parse(localStorage.getItem(k))}catch{return null}},
 set(k,v){localStorage.setItem(k,JSON.stringify(v))},
 del(k){localStorage.removeItem(k)}
};

function makeKey(file){return "book:"+file.name+":"+file.size+":"+file.lastModified}
function setTheme(t){document.body.classList.remove("dark","sepia");if(t!=="light")document.body.classList.add(t);$("themeSelect").value=t;storage.set("theme",t)}
setTheme(storage.get("theme")||"light");
$("themeSelect").onchange=e=>setTheme(e.target.value);
$("themeBtn").onclick=()=>{const t=document.body.classList.contains("dark")?"light":"dark";setTheme(t)};
$("fontSize").oninput=e=>document.documentElement.style.setProperty("--book-font",e.target.value+"px");

function loadVoices(){
 voices=speechSynthesis.getVoices();$("voiceSelect").innerHTML="";
 voices.forEach((v,i)=>{const o=document.createElement("option");o.value=i;o.textContent=`${v.name} — ${v.lang}`;$("voiceSelect").appendChild(o)});
 applyDefaultVoice(); // voice list often loads async
}
loadVoices();speechSynthesis.onvoiceschanged=loadVoices;
$("voiceSelect").onchange=()=>{userPickedVoice=true};

$("openBtn").onclick=()=>$("fileInput").click();$("emptyOpen").onclick=()=>$("fileInput").click();

$("fileInput").onchange=async e=>{
 const file=e.target.files[0];if(!file)return;
 try{
  stopSpeech();userPickedVoice=false;applyDefaultVoice();$("emptyState").classList.add("hidden");$("pdfViewport").classList.remove("hidden");
  $("bookName").textContent=file.name;$("bookMeta").textContent=`${(file.size/1024/1024).toFixed(1)} MB`;
  bookKey=makeKey(file);state=storage.get(bookKey)||{page:1,bookmarks:[]};
  pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
  pageNum=Math.min(state.page||1,pdf.numPages);
  $("infoText").textContent=`${file.name}\\n\\n${pdf.numPages} pages\\n\\nYour progress and bookmarks are saved in this browser.`;
  buildThumbStrip();
  await render();renderBookmarks();
 }catch(err){alert("Could not open this PDF. "+err.message)}
};

async function extractPageText(n){
 const p=await pdf.getPage(n), c=await p.getTextContent();
 return c.items.map(x=>x.str).join(" ").replace(/\s+/g," ").trim();
}
async function render(){
 if(!pdf)return;
 const p=await pdf.getPage(pageNum);
 const viewport=p.getViewport({scale});
 const canvas=document.createElement("canvas"),ctx=canvas.getContext("2d");
 canvas.width=viewport.width;canvas.height=viewport.height;
 const textLayerDiv=document.createElement("div");
 textLayerDiv.className="textLayer";
 textLayerDiv.style.width=viewport.width+"px";
 textLayerDiv.style.height=viewport.height+"px";
 const container=$("pageContainer");
 container.innerHTML="";
 container.style.width=viewport.width+"px";
 container.style.height=viewport.height+"px";
 container.appendChild(canvas);
 container.appendChild(textLayerDiv);
 await p.render({canvasContext:ctx,viewport}).promise;
 const textContent=await p.getTextContent();
 buildTextLayer(textContent,viewport,textLayerDiv); // also sets currentText & pageWords
 $("pageLabel").textContent=`Page ${pageNum} / ${pdf.numPages}`;
 $("zoomLabel").textContent=Math.round(scale*100)+"%";
 state.page=pageNum;storage.set(bookKey,state);updateProgress();updateActiveThumb();
 if(speaking&&activeRange&&lastHighlightIdx>=0)highlightWordWindow(lastHighlightIdx); // re-attach highlight to freshly rebuilt spans (e.g. after zoom)
}
function updateProgress(){if(!pdf)return;const pct=Math.round(pageNum/pdf.numPages*100);$("progressBar").style.width=pct+"%";$("progressText").textContent=pct+"%";}

// --- Thumbnail filmstrip ---
// Renders a scrollable row of small page previews below the reader. Thumbnails are
// rendered lazily via IntersectionObserver so opening a huge PDF doesn't render
// hundreds of pages up front — only the ones actually scrolled into view.
let thumbObserver=null;
function buildThumbStrip(){
 const strip=$("thumbStrip");
 strip.innerHTML="";
 strip.classList.remove("hidden");
 if(thumbObserver)thumbObserver.disconnect();
 thumbObserver=new IntersectionObserver(onThumbVisible,{root:strip,rootMargin:"300px",threshold:.01});
 for(let n=1;n<=pdf.numPages;n++){
  const thumb=document.createElement("div");
  thumb.className="thumb"+(n===pageNum?" active":"");
  thumb.dataset.page=n;
  thumb.innerHTML=`<div class="thumb-placeholder"></div><div class="thumb-num">${n}</div>`;
  thumb.onclick=async()=>{if(pdf&&n!==pageNum){stopSpeech();pageNum=n;await render()}};
  strip.appendChild(thumb);
  thumbObserver.observe(thumb);
 }
}
async function onThumbVisible(entries){
 for(const entry of entries){
  if(!entry.isIntersecting)continue;
  const el=entry.target;
  thumbObserver.unobserve(el);
  const n=parseInt(el.dataset.page);
  try{
   const p=await pdf.getPage(n);
   const natural=p.getViewport({scale:1});
   const thumbScale=60/natural.width;
   const viewport=p.getViewport({scale:thumbScale});
   const canvas=document.createElement("canvas");
   canvas.width=viewport.width;canvas.height=viewport.height;
   await p.render({canvasContext:canvas.getContext("2d"),viewport}).promise;
   const placeholder=el.querySelector(".thumb-placeholder");
   if(placeholder)placeholder.replaceWith(canvas);
  }catch(err){console.warn("Thumbnail render failed for page",n,err)}
 }
}
function updateActiveThumb(){
 const strip=$("thumbStrip");
 if(!strip)return;
 strip.querySelectorAll(".thumb").forEach(t=>t.classList.toggle("active",parseInt(t.dataset.page)===pageNum));
 const active=strip.querySelector(".thumb.active");
 if(active)active.scrollIntoView({behavior:"smooth",inline:"center",block:"nearest"});
}

// Build an invisible, selectable text overlay positioned directly on top of each
// rendered glyph, using PDF.js's stable Util.transform matrix helper (avoids the
// newer, less reliable pdfjsLib.TextLayer class some browsers fail to render).
// One span per WORD (not per PDF text chunk) so the voice reader can highlight
// exactly the word being spoken, right on top of the canvas.
const measureCtx=document.createElement("canvas").getContext("2d");
let pageWords=[]; // {word,span,start,end} — start/end are offsets into currentText
function buildTextLayer(textContent,viewport,container){
 container.innerHTML="";
 container.style.setProperty("--scale-factor",viewport.scale);
 pageWords=[];
 let text="";
 textContent.items.forEach(item=>{
  if(!item.str)return;
  const tx=pdfjsLib.Util.transform(viewport.transform,item.transform);
  const angle=Math.atan2(tx[1],tx[0]);
  const fontSize=Math.hypot(tx[2],tx[3]);
  if(!fontSize)return;
  measureCtx.font=`${fontSize}px sans-serif`;
  const cos=Math.cos(angle),sin=Math.sin(angle);
  let advance=0;
  const tokens=item.str.match(/\S+|\s+/g)||[];
  tokens.forEach(tok=>{
   const w=measureCtx.measureText(tok).width;
   if(/\S/.test(tok)){
    const span=document.createElement("span");
    span.textContent=tok;
    span.style.left=(tx[4]+advance*cos)+"px";
    span.style.top=((tx[5]-fontSize)+advance*sin)+"px";
    span.style.fontSize=fontSize+"px";
    if(angle)span.style.transform=`rotate(${angle}rad)`;
    container.appendChild(span);
    if(text)text+=" ";
    const start=text.length;
    text+=tok;
    pageWords.push({word:tok,span,start,end:start+tok.length});
   }
   advance+=w;
  });
 });
 currentText=text;
}
// Bundles a list of {word,span} into reading text + per-word offsets, so speech
// playback and on-canvas highlighting always stay in sync with each other.
function makeReadingSet(words){
 let text="";
 const list=words.map(w=>{
  if(text)text+=" ";
  const start=text.length;
  text+=w.word;
  return {word:w.word,span:w.span,start,end:start+w.word.length};
 });
 return {text,words:list};
}

$("prevPage").onclick=async()=>{if(pdf&&pageNum>1){stopSpeech();pageNum--;await render()}}
$("nextPage").onclick=async()=>{if(pdf&&pageNum<pdf.numPages){stopSpeech();pageNum++;await render()}}
$("zoomIn").onclick=async()=>{if(pdf){scale=Math.min(2.2,scale+.1);await render()}}
$("zoomOut").onclick=async()=>{if(pdf){scale=Math.max(.6,scale-.1);await render()}}
$("resumeBtn").onclick=async()=>{if(pdf){pageNum=state.page||1;await render()}}
$("addBookmark").onclick=()=>{if(!pdf)return;state.bookmarks.unshift({id:Date.now(),page:pageNum,label:`Page ${pageNum}`});state.bookmarks=state.bookmarks.slice(0,50);storage.set(bookKey,state);renderBookmarks()}
function renderBookmarks(){
 const el=$("bookmarks");el.innerHTML="";
 if(!state?.bookmarks?.length){el.className="list empty";el.textContent="No bookmarks yet.";return}
 el.className="list";state.bookmarks.forEach((b,i)=>{const d=document.createElement("div");d.className="bm";d.innerHTML=`<button>🔖 ${b.label}</button><button>✕</button>`;d.children[0].onclick=async()=>{stopSpeech();pageNum=b.page;await render()};d.children[1].onclick=()=>{state.bookmarks.splice(i,1);storage.set(bookKey,state);renderBookmarks()};el.appendChild(d)})
}

// --- On-canvas word highlighting for the voice reader ---
// Paints a moving highlight directly on the page's (invisible) word spans, synced to
// speech via the browser's onboundary event, so you can see exactly where it's reading.
// Highlighting always looks up spans fresh from the *current* pageWords array (by index
// range) rather than holding onto span references, so it survives a re-render mid-read
// (e.g. zooming in/out rebuilds the whole text layer with brand-new span elements).
let activeRange=null, activeWordOffsets=[], highlightedSpans=[], lastHighlightIdx=-1;
function clearHighlight(){highlightedSpans.forEach(s=>s.classList.remove("read-highlight","read-highlight-current"));highlightedSpans=[]}
function highlightWordWindow(idx){
 lastHighlightIdx=idx;
 clearHighlight();
 if(!activeRange)return;
 const start=Math.max(0,idx-1);
 const end=Math.min(activeWordOffsets.length,start+4);
 for(let i=start;i<end;i++){
  const w=pageWords[activeRange.start+i];
  if(!w||!w.span)continue;
  w.span.classList.add(i===idx?"read-highlight-current":"read-highlight");
  highlightedSpans.push(w.span);
 }
 const cur=pageWords[activeRange.start+idx];
 if(cur&&cur.span)cur.span.scrollIntoView({behavior:"smooth",block:"nearest",inline:"nearest"});
}
function splitSentences(text){
 const out=[];const re=/[^.!?]+[.!?]+|[^.!?]+$/g;let m;
 while((m=re.exec(text))){out.push({text:m[0],start:m.index})}
 return out.length?out:[{text,start:0}];
}

async function readPage(){
 startReadingRange(0,pageWords.length,"No text found on this page.");
}
function startReadingRange(rangeStart,rangeEnd,emptyMsg){
 const words=pageWords.slice(rangeStart,rangeEnd);
 if(!words.length){$("speechStatus").textContent=emptyMsg||"No text to read.";return}
 stopSpeech();
 activeRange={start:rangeStart,end:rangeEnd};
 const {text,words:withOffsets}=makeReadingSet(words);
 activeWordOffsets=withOffsets.map(w=>({start:w.start,end:w.end}));
 speechQueue=splitSentences(text);
 speechIndex=0;speaking=true;
 useFallbackTTS()?speakNextFallback():speakNext();
}
function speakNextFallback(){
 if(!speaking||speechIndex>=speechQueue.length){speaking=false;$("speechStatus").textContent="Finished";clearHighlight();return}
 const sentenceText=speechQueue[speechIndex++].text.trim();if(!sentenceText)return speakNextFallback();
 $("speechStatus").textContent=`🔊 Reading sentence ${speechIndex}/${speechQueue.length} (offline voice)`;
 // The offline engine gives no word-timing, so highlighting isn't available in this mode.
 const wpm=Math.max(80,Math.min(400,Math.round(175*parseFloat($("rate").value||"1"))));
 window.meSpeak.speak(sentenceText,{speed:wpm},()=>{if(speaking)speakNextFallback()});
}
function speakNext(){
 if(!speaking||speechIndex>=speechQueue.length){speaking=false;$("speechStatus").textContent="Finished";clearHighlight();return}
 const sentence=speechQueue[speechIndex++];
 const leadTrim=sentence.text.length-sentence.text.trimStart().length;
 const sentenceText=sentence.text.trim();
 if(!sentenceText)return speakNext();
 const u=new SpeechSynthesisUtterance(sentenceText),v=voices[parseInt($("voiceSelect").value||"0")];
 if(v){u.voice=v;u.lang=v.lang}u.rate=parseFloat($("rate").value);
 u.onstart=()=>{$("speechStatus").textContent=`🔊 Reading sentence ${speechIndex}/${speechQueue.length}`};
 u.onboundary=e=>{
  const absIdx=sentence.start+leadTrim+e.charIndex;
  const idx=activeWordOffsets.findIndex(w=>absIdx>=w.start&&absIdx<w.end);
  if(idx>=0)highlightWordWindow(idx);
 };
 u.onend=speakNext;u.onerror=()=>{speaking=false;$("speechStatus").textContent="Speech error";clearHighlight()};
 speechSynthesis.speak(u);
}
$("readPage").onclick=readPage;
$("readSelection").onclick=()=>{
 const sel=window.getSelection();
 if(!sel||sel.isCollapsed||sel.rangeCount===0){startReadingRange(0,0,"Select some text on the page first.");return}
 const range=sel.getRangeAt(0);
 const indices=[];
 pageWords.forEach((w,i)=>{if(range.intersectsNode(w.span))indices.push(i)});
 if(!indices.length){startReadingRange(0,0,"Select some text on the page first.");return}
 startReadingRange(indices[0],indices[indices.length-1]+1,"Select some text on the page first.");
};
document.addEventListener("selectionchange",updateSelectionButton);
function updateSelectionButton(){
 const sel=window.getSelection();
 const btn=$("readSelection");
 const inPage=sel&&sel.rangeCount>0&&!sel.isCollapsed&&sel.anchorNode&&$("pageContainer").contains(sel.anchorNode);
 if(!inPage){btn.disabled=true;btn.textContent="▶ Read selection";return}
 const range=sel.getRangeAt(0);
 const count=pageWords.reduce((n,w)=>n+(range.intersectsNode(w.span)?1:0),0);
 if(count>0){
  btn.disabled=false;
  btn.textContent=`▶ Read selection (${count} word${count===1?"":"s"})`;
 }else{
  btn.disabled=true;
  btn.textContent="▶ Read selection";
 }
}
$("pause").onclick=()=>{
 if(useFallbackTTS()){$("speechStatus").textContent="Pause isn't available with the offline voice — use Stop instead.";return}
 speechSynthesis.paused?speechSynthesis.resume():speechSynthesis.pause();
};
$("stop").onclick=stopSpeech;
function stopSpeech(){speaking=false;speechQueue=[];speechIndex=0;speechSynthesis.cancel();if(window.meSpeak)window.meSpeak.stop();$("speechStatus").textContent="Ready";clearHighlight();activeRange=null;activeWordOffsets=[];lastHighlightIdx=-1}

$("searchBtn").onclick=()=>$("searchPanel").classList.toggle("hidden");
let searchResults=[],searchIndex=0;
$("searchInput").onkeydown=async e=>{if(e.key==="Enter")await search()};
async function search(){
 if(!pdf)return;const q=$("searchInput").value.trim().toLowerCase();if(!q)return;
 searchResults=[];
 for(let i=1;i<=pdf.numPages;i++){const t=await extractPageText(i);if(t.toLowerCase().includes(q))searchResults.push(i)}
 searchIndex=0;$("searchCount").textContent=searchResults.length?`${searchResults.length} page(s)`:"No results";
 if(searchResults.length){pageNum=searchResults[0];await render()}
}
$("searchNext").onclick=async()=>{if(searchResults.length){searchIndex=(searchIndex+1)%searchResults.length;pageNum=searchResults[searchIndex];await render()}}
$("searchPrev").onclick=async()=>{if(searchResults.length){searchIndex=(searchIndex-1+searchResults.length)%searchResults.length;pageNum=searchResults[searchIndex];await render()}}

document.querySelectorAll(".tab").forEach(t=>t.onclick=()=>{
 document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));t.classList.add("active");
 $("readTab").classList.toggle("hidden",t.dataset.tab!=="read");$("infoTab").classList.toggle("hidden",t.dataset.tab!=="info");
});
window.addEventListener("beforeunload",()=>{if(bookKey&&state){state.page=pageNum;storage.set(bookKey,state)}});
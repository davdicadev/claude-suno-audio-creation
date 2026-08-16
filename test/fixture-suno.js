"use strict";
// Finto Suno /create: riproduce i comportamenti che contano (bottone (…) che
// compare solo al passaggio del mouse, menu Radix-like, sottomenu che si apre
// SOLO all'hover, voce che naviga verso /studio/...).
const http = require("http");

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Fake Suno</title>
<style>
 body{font-family:sans-serif;margin:0}
 .side{position:fixed;left:0;top:0;width:180px;height:100%;background:#eee;padding:8px}
 .list{margin-left:200px;padding:20px}
 .row{display:flex;align-items:center;gap:12px;padding:14px;border-bottom:1px solid #ddd}
 .row .more{visibility:hidden}
 .row:hover .more{visibility:visible}
 [role=menu]{position:absolute;background:#fff;border:1px solid #333;padding:4px;min-width:190px;z-index:10}
 [role=menuitem]{padding:8px 12px;cursor:pointer}
 [role=menuitem]:hover{background:#def}
</style></head><body>
<div class="side">
  <button aria-label="More menu contents">…</button>
  <button aria-label="More menu contents">…</button>
  <button aria-label="More menu contents">…</button>
</div>
<div class="list" id="list"></div>
<script>
const BRANI = [
  ["5be767f7-ca3b-44ee-b98c-8073c2157b2d","Rainy Caf\\u00e9 Notes"],
  ["52792a6c-63c8-4d52-af2a-f1ea3ec35471","Rainy Window"],
  ["a133da7b-6d4e-44a4-a646-d73f1114b348","Pressed Velvet"],
];
document.getElementById("list").innerHTML = BRANI.map(([id,t]) =>
  '<div class="row"><span>2:57</span><a href="/song/'+id+'">'+t+'</a>'+
  '<button class="more" aria-label="More menu contents" aria-haspopup="menu" data-id="'+id+'">…</button></div>'
).join("");

let menu=null, sub=null, timer=null;
function chiudiTutto(){ if(sub){sub.remove();sub=null;} if(menu){menu.remove();menu=null;} }
function chiudiSub(){ if(sub){sub.remove();sub=null;} }

function creaMenu(x,y,voci,onClick){
  const m=document.createElement("div");
  m.setAttribute("role","menu");
  m.style.left=x+"px"; m.style.top=y+"px";
  voci.forEach(v=>{
    const it=document.createElement("div");
    it.setAttribute("role","menuitem");
    it.textContent=v;
    if(v==="Edit") it.setAttribute("aria-haspopup","menu");
    it.addEventListener("click",()=>onClick(v,it));
    m.appendChild(it);
  });
  document.body.appendChild(m);
  return m;
}

document.addEventListener("click", e=>{
  const b=e.target.closest('button[aria-label="More menu contents"]');
  if(!b) return;
  chiudiTutto();
  if(!b.dataset.id) return; // i (…) della barra laterale non aprono nulla
  const r=b.getBoundingClientRect();
  menu=creaMenu(r.right+4, r.bottom+4,
    ["Remix","Edit","Publish","Share","Download","Manage","Add to Queue","Song Radio","Move to Trash"],
    ()=>{});
  // Il sottomenu si apre SOLO al passaggio del mouse (come Radix), mai al click.
  menu.querySelectorAll('[role=menuitem]').forEach(it=>{
    it.addEventListener("pointerover", ()=>{
      if(it.textContent!=="Edit"){ chiudiSub(); clearTimeout(timer); return; }
      if(sub) return;
      clearTimeout(timer);
      timer=setTimeout(()=>{
        const r2=it.getBoundingClientRect();
        sub=creaMenu(r2.right+2, r2.top, ["Extend","Crop","Reverse","Remaster","Open in Studio","Open in Editor"],
          (v)=>{ if(v!=="Open in Studio") return;
            chiudiTutto();
            if(!location.search.includes("dialogo")){ location.href="/studio/proj-42"; return; }
            // variante: prima chiede come importare il brano (dopo 1,5s)
            setTimeout(()=>{
              const d=document.createElement("div");
              d.setAttribute("role","dialog");
              d.style.cssText="position:fixed;left:40%;top:40%;background:#fff;border:2px solid #000;padding:20px;z-index:99";
              d.innerHTML='<p>Come vuoi aprirlo?</p><button id="multi">Separate stems</button> <button id="full">Use the full mix</button>';
              document.body.appendChild(d);
              d.querySelector("#full").addEventListener("click",()=>{ d.remove(); location.href="/studio/proj-42"; });
            }, 1500);
          });
      }, 120);
    });
  });
});
</script></body></html>`;

// Finto Studio: riproduce il caso segnalato dall'utente. Il bottone Export c'e'
// SUBITO, ma la traccia arriva dopo: prima una richiesta lenta (l'audio), poi
// la forma d'onda disegnata sul canvas e la durata del brano in pagina.
const STUDIO = `<!doctype html><html><head><meta charset="utf-8"><title>Studio</title></head>
<body>
<h1>Suno Studio</h1>
<div class="timeline-root" aria-label="Timeline">
  <canvas id="onda" width="800" height="120"></canvas>
  <div id="durata"></div>
</div>
<button id="export">Export</button>
<script>
// L'audio ci mette 3 secondi ad arrivare: fino ad allora l'export sarebbe vuoto.
fetch("/audio-lento").then(()=>{
  const c=document.getElementById("onda"), x=c.getContext("2d");
  x.fillStyle="#3a7";
  for(let i=0;i<800;i+=3) x.fillRect(i, 60-Math.random()*50, 2, Math.random()*100);
  document.getElementById("durata").textContent = "2:57";
});
// Rumore di fondo (telemetria): non deve MAI impedire di dichiarare la rete ferma.
setInterval(()=>fetch("/analytics/ping").catch(()=>{}), 400);
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/audio-lento")) {
    return setTimeout(() => res.end("audio"), 3000);
  }
  if (req.url.startsWith("/analytics")) {
    res.setHeader("Content-Type", "text/plain");
    return res.end("ok");
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(req.url.startsWith("/studio") ? STUDIO : PAGE);
});

module.exports = { server };
if (require.main === module) server.listen(0, () => console.log(server.address().port));

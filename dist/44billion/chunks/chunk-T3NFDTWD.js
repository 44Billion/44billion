import{b as Ie,c as ue,d as Ke}from"./chunk-FZKW7XBH.js";import{c as xe,d as Pe,e as de,f as Oe,n as Re,p as $e,q as pe}from"./chunk-TG3GHENF.js";import{a as Q,e as H,f as Se,g as Me,j as we,l as ce}from"./chunk-4YEM5IRY.js";import{a as G,b as j,f as se}from"./chunk-LLMC3MZB.js";import{g as V,i as ge,j as Be,n as C,o as le,p as ee,q as Te,s as te,v as M}from"./chunk-5XJKKVB7.js";var be="0123456789abcdefghijklmnopqrstuvwxyz",ze=BigInt(be.length),Ye=be[0],Qe=new Map([...be].map((t,e)=>[t,BigInt(e)]));function Ge(t,e=0){return Ue(Q(t),e)}function Ue(t,e=0){return Xe(et(t),e)}function vt(t,e=0){return Ge(Se(t),e)}function Le(t){return Ze(Je(t))}function Je(t){if(typeof t!="string")throw new Error("Input must be a string.");let e=0n;for(let s of t){let n=Qe.get(s);if(n===void 0)throw new Error(`Invalid character in Base36 string: ${s}`);e=e*ze+n}return e}function Xe(t,e){if(typeof t!="bigint")throw new Error("Input must be a BigInt.");if(t<0n)throw new Error("Can't be signed BigInt");return t.toString(36).padStart(e,Ye)}function Ze(t){if(typeof t!="bigint")throw new Error("Input must be a BigInt.");if(t<0n)throw new Error("Can't be signed BigInt");let e=t.toString(16);return e.length%2!==0&&(e=`0${e}`),e}function et(t){if(typeof t!="string")throw new Error("Input must be a string.");return BigInt(`0x${t}`)}function Ce(t){if(t instanceof Error)return t;let e=new Error(t.message);return e.name=t.name||"Error",e.stack=t.stack,Object.assign(e,t.context||{}),e}var We=!1,tt=We?"http://":"https://",st=We?"localhost:10000":"44billion.net",Tt=`${tt}${st}`;var ne={};function nt(){return Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)}function ot(t,e,s=5e3){if(!t||!e)throw new Error("Missing request id or code");let{promise:n,resolve:_,reject:a}=Promise.withResolvers();ne[t]={resolve:_,reject:a};let i;return s!=null&&(s>0?i=setTimeout(()=>{ne[t]?.reject?.(`Timeout for ${e} reqId: ${t}`)},s):ne[t]?.reject?.(`Timeout for ${e} reqId: ${t}`)),n.finally(()=>{clearTimeout(i),delete ne[t]})}function rt(t){let e=ne[t.data.reqId];if(!e){console.log(`Unhandled response for reqId ${t.data.reqId} (may have timed out)`,JSON.stringify(t.data));return}t.data.error?e.reject(Ce(t.data.error)):e.resolve({payload:t.data.payload,isLast:t.data.isLast??!0,ports:t.ports})}var at=((t,e=new WeakMap,s=new FinalizationRegistry(n=>n.abort()))=>n=>{let _=n instanceof MessagePort;if(t=_?n:globalThis,e.has(t))return;let a=new AbortController;e.set(t,a),t.addEventListener("message",async i=>{if(i.data.code==="REPLY")return rt(i)},{signal:a.signal}),_&&t.start(),s.register(t,a)})();async function ke(t,e,s,n){if(!e.code&&!("payload"in e))throw new Error("Missing args");(!s||typeof s!="object")&&(s={targetOrigin:s,transfer:n}),at(t);let _=nt(),a=ot(_,e.code,s.timeout);return t.postMessage({...e,reqId:_},s),a.then(({payload:i,ports:c})=>({code:e.code,payload:i,ports:c})).catch(i=>({code:e.code,payload:null,error:i}))}function K(t,e,s,n){if(!("payload"in e)&&!("error"in e))throw new Error("Missing args");if((!s||typeof s!="object")&&(s={targetOrigin:s,transfer:n}),s.targetOrigin??=t.origin,!s.to&&!t.source)throw new Error("Set port to options.to");s.to??=t.source,s.to.postMessage({...e,reqId:t.data.reqId,code:"REPLY"},s)}function W(t,e,s,n){if(!e.code||!("payload"in e)&&!("error"in e))throw new Error("Missing args");(!s||typeof s!="object")&&(s={targetOrigin:s,transfer:n}),t.postMessage(e,s)}async function it(t,e,s){try{let n=s.map(r=>$e(r)),_=new Blob(n,{type:e.contentType}),a=new FileReader,c=await new Promise((r,o)=>{a.onload=()=>r(a.result),a.onerror=o,a.readAsDataURL(_)}),g={fx:e.rootHash,url:c};return G(localStorage,`session_appById_${t}_icon`,g),g}catch(n){console.log("Failed to update icon storage:",n)}}async function Nt(t,e,s,n,_,a,i,c,g,r,o,{signal:p,isSingleNapp:w=!1,onFileNotCached:u=null}={}){let f=Le(t),$=H(f)===JSON.parse(localStorage.getItem("session_defaultUserPk")),x=new URL(JSON.parse(localStorage.getItem("config_vaultUrl")));document.querySelector(`iframe[src="${x.href.replace(/\/$/,"")}"]`)||console.warn("Vault iframe not found");let O=we(e),L=pe.create(e,O);L.catch(()=>{});let y;try{y=p?await Promise.race([L,new Promise((d,U)=>{if(p.aborted)return U(new Error("aborted"));p.addEventListener("abort",()=>U(new Error("aborted")),{once:!0})})]):await L}catch{if(p?.aborted)return;u&&u();return}w&&y.updateSiteManifestMetadata({lastOpenedAsSingleNappAt:Date.now()});let E=null,T=null;p?.addEventListener("abort",()=>{E&&(E.close(),E=null),T&&(T.close(),T=null)},{once:!0});let S,J=location.origin.replace("//",`//${s}.`);window.addEventListener("message",d=>{d.data.code!=="TRUSTED_IFRAME_READY"||d.source!==_.contentWindow||d.origin!==J||(S?.abort(),S=new AbortController,E&&E.close(),E=d.ports[0],je(E,AbortSignal.any([p,S.signal])),X(s,n))},{signal:p});let ye=!1;function X(d,U=""){if(ye)return;ye=!0;let h;window.addEventListener("message",m=>{m.data.code!=="APP_IFRAME_READY"||m.source!==a.contentWindow||m.origin!==J||(h?.abort(),h=new AbortController,T&&T.close(),T=m.ports[0],He(T,AbortSignal.any([p,h.signal])))},{signal:p});let l=window.location.host;i(`//${d}.${l}${U}`)}function je(d,U){d.addEventListener("message",async h=>{switch(h.data.code){case"STREAM_APP_FILE":{let l=(m,b=new Error("FILE_NOT_CACHED"))=>(m&&console.log(m),u&&b.message!=="HTML_FILE_NOT_CACHED"&&u(h.data.payload.pathname),K(h,{error:b,isLast:!0},{to:d}));try{let m=await y.getFileCacheStatus(h.data.payload.pathname,null,{withMeta:!0});if(!m.isCached)if(m.isHtml)l(null,new Error("HTML_FILE_NOT_CACHED"));else{let{fileRootHash:B,total:A}=m,k=0,v=!1,I=!1,N=!1,Z=async()=>{if(!(v||I||N)){N=!0;try{for(;!v&&!I;){let R=await Pe(e,B,{fromPos:k,toPos:k});if(R.length===0)break;let F=R[0];if(A===null){let z=F.evt.tags.find(ie=>ie[0]==="c"&&ie[1].startsWith(`${B}:`)),Y=parseInt(z?.[2]);!Number.isNaN(Y)&&Y>0&&(A=Y)}let P=A!=null&&k===A-1;K(h,{payload:{content:F.evt.content,...k===0&&{contentType:m.contentType}},isLast:P},{to:d}),k++,P&&(I=!0)}}catch(R){v=!0,l(R)}finally{N=!1}}},ae=async({progress:R,chunkIndex:F,total:P,error:z})=>{if(v||I)return;if(z){v=!0;let me=c(),{[h.data.payload.pathname]:qe,..._e}=me;return c(_e),l(z)}P&&A===null&&(A=P);let Y=h.data.payload.pathname,ie=c();c({...ie,[Y]:{progress:R,totalByteSizeEstimate:A?(A-1)*51e3:0}}),R>=100&&setTimeout(()=>{let me=c(),{[Y]:qe,..._e}=me;c(_e)},1e3),typeof F=="number"?F===k&&await Z():await Z()};try{if(await Z(),!I&&!v)return y.cacheFile(h.data.payload.pathname,m.pathTag,ae)}catch(R){return l(R)}}let b=0;for await(let B of de(e,y.getFileRootHash(h.data.payload.pathname)))K(h,{payload:{content:B.evt.content,...b===0&&{contentType:m.contentType}},isLast:++b===m.total},{to:d})}catch(m){return l(m,m)}break}}},{signal:U}),d.start(),W(d,{code:"BROWSER_READY",payload:null})}let q=new Map,re=new Map;async function he(d,U,{timeoutMs:h=1750}={}){if(q.has(d))return q.get(d);re.has(d)||re.set(d,{icon:!1,name:!1,promise:null});let l=re.get(d);if(l.promise)return l.promise;U??=we(d);let m=await pe.create(d,U),b={id:d,napp:Ie(U)},B=[];!("icon"in b)&&!l.icon&&(l.icon=!0,B.push(m.getIcon().then(k=>k&&(b.icon=k)).finally(()=>{l.icon=!1}))),!("name"in b)&&!l.name&&(l.name=!0,B.push(m.getName().then(k=>k&&(b.name=k)).finally(()=>{l.name=!1})));let A=(async()=>{if(B.length>0){let k=Promise.all(B).then(()=>q.set(d,b));await Promise.race([k,new Promise(v=>setTimeout(v,h))])}return q.set(d,b),re.delete(d),b})();return l.promise=A,A}function He(d,U){d.addEventListener("message",async h=>{switch(h.data.code){case"OPEN_APP":{let l;try{let{href:m}=h.data.payload,B=new URL(m,self.location.origin).pathname,A=/^\/(\+{1,3}[a-zA-Z0-9]{48,})/,k=B.match(A);if(!k){console.error("Invalid app URL format:",m);break}let v=k[1],I=ue(v);l=ce(I);let N=await he(l,I,{timeoutMs:0});await r({app:await he(e,O),name:"openApp",eKind:null,meta:{targetApp:N}}),o(m)}catch(m){let b=!1;for(let B of JSON.parse(localStorage.getItem("session_workspaceKeys"))??[])if(b=Array.isArray(JSON.parse(localStorage.getItem(`session_workspaceByKey_${B}_appById_${l}_appKeys`))),b)break;b||(G(localStorage,`session_appById_${l}_icon`,void 0),G(localStorage,`session_appById_${l}_name`,void 0),G(localStorage,`session_appById_${l}_description`,void 0),G(localStorage,`session_appById_${l}_relayHints`,void 0),await(await pe.create(l)).clearAppFiles()),console.error("Error in OPEN_APP handler:",m)}break}case"NIP07":{if(["peek_public_key","get_public_key"].includes(h.data.payload.method)&&h.data.payload.ns[0]===""&&h.data.payload.ns.length===1){K(h,{payload:f},{to:d});break}let{ns:l,method:m,params:b=[]}=h.data.payload,B=await he(e,O,{timeoutMs:0}),A;try{A=await dt(g,f,l,m,b,{isDefaultUser:$,requestPermission:r,app:B})}catch(k){A={error:k}}K(h,A,{to:d});break}case"WINDOW_NAPP":{lt(h);break}case"STREAM_APP_ICON":{try{let l=y.getFaviconMetadata();if(!l){let v=await y.getIcon();if(!v?.url){K(h,{error:new Error("No icon"),isLast:!0},{to:d});break}let I=v.url.indexOf(","),N=v.url.slice(5,I).split(";")[0]||null,Z=N||"application/octet-stream",ae=Uint8Array.from(atob(v.url.slice(I+1)),P=>P.charCodeAt(0)),R=51e3,F=Math.max(1,Math.ceil(ae.length/R));for(let P=0;P<F;P++){let z=new Re().update(ae.slice(P*R,(P+1)*R)).getEncoded();K(h,{payload:{content:z,...P===0&&{mimeType:N,contentType:Z}},isLast:P===F-1},{to:d})}break}let m=await y.getFileCacheStatus(null,l.tag,{withMeta:!0});if(m.isCached||(await y.cacheFile(null,l.tag),m=await y.getFileCacheStatus(null,l.tag,{withMeta:!0})),y.service==="blossom"){let v=Oe.create();for await(let I of de(e,l.rootHash))v.update($e(I.evt.content));if(Q(v.digest())!==l.rootHash){l.rootHash&&await xe(e,l.rootHash),K(h,{error:new Error("Icon hash mismatch"),isLast:!0},{to:d});break}}let B=JSON.parse(localStorage.getItem(`session_appById_${e}_icon`))?.fx!==l.rootHash,A=[],k=0;for await(let v of de(e,l.rootHash))B&&A.push(v.evt.content),K(h,{payload:{content:v.evt.content,...k===0&&{mimeType:l.mimeType||m.mimeType,contentType:l.contentType||m.contentType}},isLast:++k===m.total},{to:d});if(A.length>0){let{url:v}=await it(e,l,A);if(q.has(e)){let I=q.get(e);I.icon={fx:l.rootHash,url:v}}}}catch(l){console.log(l.stack),K(h,{error:l,isLast:!0},{to:d})}break}case"CACHE_APP_FILE":{try{let l=({progress:m,error:b})=>{if(b)u&&u(h.data.payload.pathname),K(h,{error:b,isLast:!0},{to:d});else{let B=m>=100;K(h,{payload:m,isLast:B},{to:d})}};y.cacheFile(h.data.payload.pathname,null,l)}catch(l){console.log(h.data.payload.pathname,"error:",l.stack),u&&u(h.data.payload.pathname),K(h,{error:l,isLast:!0},{to:d})}break}}},{signal:U}),d.start(),W(d,{code:"BROWSER_READY",payload:null})}}function lt(t){return K(t,{error:new Error("Not implemented yet")})}var ct={getPublicKey:"readProfile",signEvent:"signEvent",nip04Encrypt:"encrypt",nip04Decrypt:"decrypt",nip44Encrypt:"encrypt",nip44Decrypt:"decrypt"};function ut(t){return ct[t]||(()=>{throw new Error(`Unknown method ${t}`)})()}async function dt(t,e,s,n,_,{isDefaultUser:a,requestPermission:i,app:c}={}){if(a)throw new Error("Please login");if(i){let p=n.includes("_")?n.replace(/_([a-z0-9])/g,(u,f)=>f.toUpperCase()):n,w=(()=>{switch(p){case"signEvent":return _?.[0]?.kind;default:return null}})();await i({app:c,name:ut(p),eKind:w,meta:{params:_}})}let{napp:g,...r}=c,o={code:"NIP07",payload:{app:{...r,id:g},pubkey:e,ns:s,method:n,params:_}};return t(o,{timeout:12e4})}function ve(){return H(pt(),43)}function pt(){let t=crypto.getRandomValues(new Uint8Array(40)),s=2n**256n-0x14551231950b75fc4402da1732fc9bebfn;return(((i,c)=>{let g=i%c;return g>=0n?g:c+g})((i=>BigInt("0x"+(Q(i)||"0")))(t),s-1n)+1n).toString(16).padStart(64,"0")}var Ne=["+32Wp7Qdz5XIbjlzHht7GdEP8IDxk6CC90ee8lRxYjx0stjsVD8yzTguF","+3swFhu23QNl8er5yOtc8bf9ueHCdwF8CzoDUiSSwwKIWoS8Ki5TwMyeA3Js1"].map(ue).map(ce);function ft(){let t=j(localStorage),e=j(sessionStorage);return Te("hardcoded_newAppIdsObj",{}),M(()=>{if(t.session_workspaceKeys$())return;let s=ve();t.session_defaultUserPk$(s),De({userPk:s,storage:t,tabStorage:e,isFirstTimeUser:!0})}),M(()=>{if(!t.session_workspaceKeys$())return;let s=t.session_workspaceKeys$()||[],n=t.session_defaultUserPk$();s.forEach(_=>{let a=t[`session_workspaceByKey_${_}_userPk$`]();a!=null&&a!==n&&!(t[`session_accountByUserPk_${a}_isReadOnly$`]()??!1)&&t[`session_accountByUserPk_${a}_isLocked$`](!0)})}),M(({track:s})=>{if(s(()=>t.session_workspaceKeys$().length>0))return;let n=ve();t.session_defaultUserPk$(n),De({userPk:n,storage:t,tabStorage:e,isFirstTimeUser:!0})}),t}function De({userPk:t,storage:e,tabStorage:s,isFirstTimeUser:n}){let _=Ne.map((c,g)=>({id:c,key:Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),visibility:"closed",isNew:!1})),a=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);e.config_isSingleWindow$()===void 0&&e.config_isSingleWindow$(!1);let i=[];s[`session_workspaceByKey_${a}_openAppKeys$`](i),e[`session_workspaceByKey_${a}_userPk$`](t),_.forEach(c=>{e[`session_workspaceByKey_${a}_appById_${c.id}_appKeys$`]([c.key]),e[`session_appByKey_${c.key}_id$`](c.id),s[`session_appByKey_${c.key}_visibility$`](c.visibility),e[`session_appByKey_${c.key}_route$`]("")}),e[`session_workspaceByKey_${a}_unpinnedCoreAppIdsObj$`]({}),e[`session_workspaceByKey_${a}_pinnedAppIds$`](_.map(({id:c})=>c)),e[`session_workspaceByKey_${a}_unpinnedAppIds$`]([]),e[`session_accountByUserPk_${t}_isReadOnly$`](!0),e[`session_accountByUserPk_${t}_isLocked$`](!1),e[`session_accountByUserPk_${t}_profile$`]({npub:Ke(Me(t)),meta:{events:[]}}),e[`session_accountByUserPk_${t}_relays$`]({meta:{events:[]}}),e.session_accountUserPks$([t]),e.session_workspaceKeys$([a]),e.session_openWorkspaceKeys$([a])}async function Ee(t,e,s){let n=e.session_workspaceKeys$()||[],_=e.session_openWorkspaceKeys$()||[],a=e.session_defaultUserPk$(),i=n.length===1&&n.every(o=>e[`session_workspaceByKey_${o}_userPk$`]()===a);if(t.length===0&&i)return;let c=e.session_accountUserPks$()||[],g=t.map(o=>H(o.pubkey)),r;if(t.forEach(o=>{let p=H(o.pubkey);e[`session_accountByUserPk_${p}_isReadOnly$`](r=o.isReadOnly??!1),e[`session_accountByUserPk_${p}_isLocked$`](r?!1:o.isLocked??!0),e[`session_accountByUserPk_${p}_profile$`](o.profile),e[`session_accountByUserPk_${p}_relays$`](o.relays)}),i&&g.length===1){let o=n[0],p=g[0],w=s[`session_workspaceByKey_${o}_openAppKeys$`]()||[],u=[];w.forEach(f=>{s[`session_appByKey_${f}_visibility$`]($=>($==="open"&&u.push(f),"closed"))}),s[`session_workspaceByKey_${o}_openAppKeys$`]([]),e[`session_workspaceByKey_${o}_userPk$`](p),await new Promise(f=>setTimeout(f,0)),u.forEach(f=>{s[`session_appByKey_${f}_visibility$`]("open")}),s[`session_workspaceByKey_${o}_openAppKeys$`](u),e.session_defaultUserPk$(void 0)}else{let o=g.filter(y=>!c.includes(y)),p=c.filter(y=>!g.includes(y));o.length>0&&a&&e.session_defaultUserPk$(void 0);let w=[];for(let y of p)w=w.concat(n.filter(E=>e[`session_workspaceByKey_${E}_userPk$`]()===y));let u=[];for(let y of o){let E=Ne.map(S=>({id:S,key:Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),visibility:"closed",isNew:!1})),T=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);u.push(T),s[`session_workspaceByKey_${T}_openAppKeys$`]([]),e[`session_workspaceByKey_${T}_userPk$`](y),E.forEach(S=>{e[`session_workspaceByKey_${T}_appById_${S.id}_appKeys$`]([S.key]),e[`session_appByKey_${S.key}_id$`](S.id),s[`session_appByKey_${S.key}_visibility$`](S.visibility),e[`session_appByKey_${S.key}_route$`]("")}),e[`session_workspaceByKey_${T}_unpinnedCoreAppIdsObj$`]({}),e[`session_workspaceByKey_${T}_pinnedAppIds$`](E.map(({id:S})=>S)),e[`session_workspaceByKey_${T}_unpinnedAppIds$`]([])}let f=new Set(w),$=n.filter(y=>!f.has(y)).concat(u),x=new Set($),D=_.filter(y=>x.has(y)),O=new Set(D),L=D.concat($.filter(y=>!O.has(y)));e.session_openWorkspaceKeys$(L),e.session_workspaceKeys$($);for(let y of w){let E=e[`session_workspaceByKey_${y}_pinnedAppIds$`]()||[],T=e[`session_workspaceByKey_${y}_unpinnedAppIds$`]()||[],S=[...new Set([...E,...T])];e[`session_workspaceByKey_${y}_unpinnedCoreAppIdsObj$`](void 0),e[`session_workspaceByKey_${y}_pinnedAppIds$`](void 0),e[`session_workspaceByKey_${y}_unpinnedAppIds$`](void 0),e[`session_workspaceByKey_${y}_userPk$`](void 0),s[`session_workspaceByKey_${y}_openAppKeys$`](void 0),S.forEach(J=>{(e[`session_workspaceByKey_${y}_appById_${J}_appKeys$`]()||[]).forEach(X=>{e[`session_appByKey_${X}_id$`](void 0),s[`session_appByKey_${X}_visibility$`](void 0),e[`session_appByKey_${X}_route$`](void 0)}),e[`session_workspaceByKey_${y}_appById_${J}_appKeys$`](void 0)})}}e.session_accountUserPks$(g),c.filter(o=>!g.includes(o)).forEach(o=>{e[`session_accountByUserPk_${o}_isReadOnly$`](void 0),e[`session_accountByUserPk_${o}_isLocked$`](void 0),e[`session_accountByUserPk_${o}_profile$`](void 0),e[`session_accountByUserPk_${o}_relays$`](void 0)})}var ss=V("aModal",function(){let t=le({dialogRef$:null,render:this.props.render,shouldAlwaysDisplay$:this.props.shouldAlwaysDisplay$??this.props.shouldAlwaysDisplay??!1,isOpen$:this.props.isOpen$,close:this.props.close,afterClose:this.props.afterClose});return M(({track:e})=>{e(()=>t.isOpen$.get())?t.dialogRef$().showModal():t.dialogRef$().close()},{after:"rendering"}),this.h`
    <dialog
      ref=${t.dialogRef$}
      data-name='modal'
      closedby='any'
      onclose=${t.close}
      class="scope_g7h2g1"
    >
      <style>
        .scope_g7h2g1 {
          & /* &:modal are those opened with showModal() instead of show() */ {
            container-type: normal;
            --duration: .3s;
            /* display: none; (default) */
            transition:
              overlay var(--duration) ease-in-out allow-discrete,
              display var(--duration) ease-in-out allow-discrete;
            /* reset [popover] */
            &:focus-visible { outline: 0; }
            color: initial;
            background-color: initial;
            padding: 0;
            border: 0;
            inset: initial;
            width: initial;
            height: initial;
            overflow: initial;
            /* reset [dialog] */
            inset-inline-start: initial;
            inset-inline-end: initial;
          }

          /* &:popover-open, */ &[open] /* after dialog.showModal() */ {
            /* --modal-state: open; /* only for dialog modal */
          }

          /* &:popover-open::backdrop, */ &[open]::backdrop {
            opacity: 0.6;
            backdrop-filter: blur(1px);

            @starting-style {
              opacity: 0;
              backdrop-filter: blur(0px);
            }
          }

          &::backdrop {
            /* display: none; (default) */
            opacity: 0;
            backdrop-filter: blur(0px);
            position: absolute;
            inset: 0;
            background-color: black;
            transition:
              opacity var(--duration) ease-in-out,
              backdrop-filter var(--duration) ease-in-out,
              overlay var(--duration) ease-in-out allow-discrete,
              display var(--duration) ease-in-out allow-discrete;
          }
        }
      </style>
      <div
        data-name='modalContentContainer'
        class="scope_f82h1k"
      >
        <style>
          ${`.scope_f82h1k {
            & {
              position: fixed;
              transition: var(--duration) ease-in-out;
              border-top-right-radius: 17px; /* for scrollbar */
              overflow: hidden; /* for scrollbar */

              @media ${se.breakpoints.desktop} {
                transition-property: bottom, transform;
                bottom: 0;
                transform: translate(-50%, 100%);
                left: 50%;
                /* @container style(:popover-open), style(--modal-state: open) { */
                .scope_g7h2g1[open] & {
                  bottom: 50%;
                  transform: translate(-50%, 50%);
                  @starting-style {
                    bottom: 0;
                    transform: translate(-50%, 100%);
                  }
                }
                border-bottom-right-radius: 17px; /* for scrollbar */
              }

              @media ${se.breakpoints.mobile} {
                transition-property: top, transform;
                transform: translate(0, 0);
                top: 100%;
                /* @container style(:popover-open), style(--modal-state: open) { */
                .scope_g7h2g1[open] & {
                  transform: translate(0, -100%);
                  @starting-style {
                    transform: translate(0, 0);
                  }
                }
              }
            }
          }`}
        </style>
        <div
          data-name='modalContent'
          class="scope_j3k1h2"
        >
          <style>
            ${`.scope_j3k1h2 {
              & {
                overflow-y: auto;
                /*
                  https://gist.github.com/adamcbrewer/5859738
                  https://stackoverflow.com/questions/5736503/how-to-make-css3-rounded-corners-hide-overflow-in-chrome-opera
                  the scroll without this ignores border-radius
                  but it will blur content
                  mask-image: -webkit-radial-gradient(circle, white, black);
                */

                display: flex;
                flex-direction: column;
                /* background-color: white; */
                min-height: 50px; /* when there is loading (dynamic content) */

                @media ${se.breakpoints.desktop} {
                  border-radius: 17px;
                  min-width: 400px;
                  width: 800px;
                  max-width: 90vw;
                  max-width: 90dvw;
                  max-height: 90vh; /* leave 10 for browser collapsible header */
                  max-height: 90dvh;
                }

                @media ${se.breakpoints.mobile} {
                  border-top-left-radius: 17px;
                  border-top-right-radius: 17px;
                  width: 100vw;
                  width: 100dvw;
                  max-height: 85vh;
                  max-height: 85dvh;
                }
              }

              ${(t.shouldAlwaysDisplay$.get()||"")&&`
                content-visibility: auto;
                contain-intrinsic-width: auto 400px;
                contain-intrinsic-height: auto 200px;
              `}
            }`}
          </style>
          ${(t.shouldAlwaysDisplay$.get()||t.isOpen$.get()||"")&&(t.render?.call(this)??"")}
        </div>
      </div>
    </dialog>
  `},{useShadowDOM:!1});function Ae(t){return t?yt(t):te("<a-modal>")}function yt(t){return te("<a-modal>",t)}V("vaultModal",function(){let t=Ae(),e=le(()=>({...t,shouldAlwaysDisplay$:!0,render:ge(function(){return this.h`<vault-messenger-wrapper />`})}));return this.h`<a-modal props=${e} />`});V("vault-messenger-wrapper",function(){let t=j(localStorage),{config_vaultUrl$:e}=t;M(()=>{e()===void 0&&e("https://44billion.github.io/44b-vault")});let s=Be(!1);M(async({track:_,cleanup:a})=>{let i=_(()=>e());if(!i){s(!1);return}s(!1);let c=0,g,r=new AbortController;a(()=>{clearTimeout(g),r.abort()});let o=async()=>{try{if(await fetch(i,{mode:"no-cors",signal:r.signal}),r.signal.aborted)return;s(!0)}catch{if(r.signal.aborted)return;c++;let w=Math.min(3e4,500*2**c);console.warn(`Vault unreachable, retrying in ${w}ms`),g=setTimeout(o,w)}};o()},{after:"rendering"});let{vaultPort$:n}=Fe({shouldInit:!0});return Ve(n),!e()||!s()?this.h``:this.h`${this.h({key:e()})`<vault-messenger />`}`});function Fe({shouldInit:t=!1}={}){return t?ee("vaultMessenger",()=>({isWorkarounEnabled$:!0,disableStartAtVaultHomeWorkaroundThisTime(){this.isWorkarounEnabled$(!1)},isFirstRun$:!0,vaultPort$:null,vaultIframeRef$:null,vaultIframeSrc$:"about:blank",isVaultMessengerReady$:!1,widgetHeight$:0})):ee("vaultMessenger")}V("vault-messenger",function(){let{isFirstRun$:t,vaultPort$:e,vaultIframeRef$:s,vaultIframeSrc$:n,isVaultMessengerReady$:_,widgetHeight$:a,isWorkarounEnabled$:i}=Fe();M(({cleanup:f})=>f(()=>{e(null),n("about:blank")}));let c=j(localStorage),g=j(sessionStorage),{config_vaultUrl$:r}=c,{cancelPreviousRequests:o,postVaultMessage:p}=Ve(e),w=Ae(),{isOpen$:u}=w;return M(({track:f})=>{let $=f(()=>u());t()||$||e()&&p({code:"CLOSED_VAULT_VIEW",payload:null},{instant:!0})}),M(({track:f})=>{let $=i();i(!0);let x=f(()=>!u());t()||x||!$||e()&&p({code:"OPEN_VAULT_HOME",payload:null},{instant:!0})}),M(()=>{t(!1)}),M(async({track:f,cleanup:$})=>{f(()=>r());let x=new AbortController;$(()=>{x.abort()});let D=new URL(r()).origin,O,L=()=>{O&&O.abort()},y=E=>{O=E,E&&E.signal.addEventListener("abort",()=>{O===E&&(O=null)},{once:!0})};s().addEventListener("load",()=>{setTimeout(()=>{L();let E=_t({vaultIframe:s(),vaultPort$:e,abortSignal:x.signal});y(E)},100)},{signal:x.signal}),mt({vaultIframe:s(),vaultOrigin:D,vaultPort$:e,componentSignal:x.signal,widgetHeight$:a,storage:c,tabStorage:g,stopRenderHandshake:L,vaultModalStore:w}),_(!0)},{after:"rendering"}),M(async({track:f})=>{let[$,x]=f(()=>[_(),r()]);$&&(n(x),o(new Error("Canceled due to new vault URL selection")))}),this.h`
    <style>
      #vault {
        border: none;
        width: 100%;
        height: 100%;
        display: block; /* ensure it's not inline */
      }
    </style>
    <iframe
      allow='clipboard-write;
             publickey-credentials-create;
             publickey-credentials-get'
      style=${{height:`${a()}px`}}
      id='vault'
      ref=${s}
      src=${n()}
    />
  `});var oe=null,fe=[],ht=50;function cs(t){if(!oe){fe.length<ht&&fe.push(t);return}W(oe,t)}function mt({vaultIframe:t,vaultOrigin:e,vaultPort$:s,componentSignal:n,widgetHeight$:_,storage:a,tabStorage:i,stopRenderHandshake:c,vaultModalStore:g}){let r=null;n?.addEventListener("abort",()=>{r&&(r.close(),r=null,oe=null,fe.length=0)},{once:!0});let o;window.addEventListener("message",u=>{u.data.code!=="VAULT_READY"||u.source!==t.contentWindow||u.origin!==e||!u.ports[0]||(u.data.payload.accounts?Ee(u.data.payload.accounts,a,i):console.log("Missing account data on vault startup"),o?.abort(),o=new AbortController,r&&r.close(),r=u.ports[0],oe=r,p({vaultPort:r,signal:AbortSignal.any([n,o.signal])}),c?.(),w(r),fe.splice(0).forEach(f=>W(oe,f)),s(r))},{signal:n});function p({vaultPort:u,signal:f}){u.addEventListener("message",$=>{switch($.data.code){case"CHANGE_DIMENSIONS":{_($.data.payload.height);break}case"CLOSE_VAULT_VIEW":{g.close();break}case"SET_ACCOUNTS_STATE":{if(!$.data.payload.accounts){console.log("Missing account data on vault message");break}Ee($.data.payload.accounts,a,i);break}}},{signal:f}),u.start()}function w(u){W(u,{code:"BROWSER_READY",payload:null})}}function _t({vaultIframe:t,vaultPort$:e,abortSignal:s}){if(s?.aborted)return null;let n=new AbortController,{signal:_}=n,a,i=()=>{n.signal.aborted||n.abort()};s&&s.addEventListener("abort",i,{once:!0}),_.addEventListener("abort",()=>{a&&clearTimeout(a)},{once:!0});let c=40,g=0,r=()=>{if(_.aborted)return;let o=t?.contentWindow;if(!o){i();return}if(W(o,{code:"RENDER",payload:null},{targetOrigin:"*"}),e()){i();return}if(g>=c){i();return}g+=1;let p=Math.min(500,50*g);a=setTimeout(r,p)};return r(),n}function Ve(t){return t!==void 0&&gt(t),ee("useRequestVaultMessage")}function gt(t){let e=j(localStorage),{config_vaultUrl$:s}=e,{msgQueue$:n}=ee("useRequestVaultMessage",()=>({vaultPort$:t,vaultOrigin$(){return new URL(s()).origin},msgQueue$:{waiting:[],running:[]},postVaultMessage(r){if(!this.vaultPort$())return Promise.reject(new Error("Vault not connected"));W(this.vaultPort$(),r)},async requestVaultMessage(r,{timeout:o,instant:p=!1}={}){if(p)return this.vaultPort$()?ke(this.vaultPort$(),r,{...o!=null&&{timeout:o}}):Promise.reject(new Error("Vault not connected"));let w=Date.now(),u=Promise.withResolvers();return u.promise.finally(()=>{this.msgQueue$(f=>(f.running=f.running.filter($=>$.p!==u),{...f}))}),this.msgQueue$(f=>(f.waiting.push({msg:r,timeout:o,queuedAt:w,p:u}),{...f})),u.promise},cancelPreviousRequests(r){this.msgQueue$().running.forEach(o=>o.p.resolve({code:o.msg.code,payload:null,error:r||new Error("Canceled")}))}})),_=Ae(),{session_openWorkspaceKeys$:a}=e,i=C(()=>{let r=a()[0];return e[`session_workspaceByKey_${r}_userPk$`]()}),c=C(()=>i()!==e.session_defaultUserPk$()||a().length>1),g=ge(r=>c()?!1:(_.open(),r.p.resolve({code:r.msg.code,payload:null,error:new Error("Not logged in")}),!0));M(({track:r})=>{let[o,p]=r(()=>[n(),t()]);if(!p)return;let w=Math.min(5-o.running.length,o.waiting.length),u=Date.now();for(let f=0;f<w;f++){let $=o.waiting.shift();if(o.running.push($),g($))return;let{msg:x,timeout:D,queuedAt:O,p:L}=o.running[o.running.length-w+f];ke(p,x,{...D!=null&&{timeout:O+D-u}}).then(y=>{L.resolve(y)})}})}V("nappAssetsCachingProgressBar",function(){let t;try{({cachingProgress$:t}=te("<napp-assets-caching-progress-bar>"))}catch(i){console.warn("No cachingProgress$ store found",i);return}let e=C(()=>Object.entries(t()).filter(([i])=>!i.startsWith("_")&&(i.startsWith("/")||i.includes(".")))),s=C(()=>e().length>0),n=C(()=>{let i=e();if(i.length===0)return{overallProgress:0,fileList:"",fileCount:0};let c=i.reduce((p,[w,u])=>p+u.progress,0),g=Math.round(c/i.length),r=i.map(([p])=>{let w=p.split("/").pop()||p;return w.length>20?w.slice(0,17)+"...":w}),o=r.length>3?r.slice(0,3).join(", ")+`... (+${r.length-3} more)`:r.join(", ");return{overallProgress:g,fileList:o,fileCount:i.length}}),_=C(()=>`
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1000;
    background: linear-gradient(90deg,
      oklch(0.62 0.22 297.62 / 0.9) 0%,
      oklch(0.62 0.22 297.1 / 0.9) ${n().overallProgress}%,
      rgba(0, 0, 0, 0.7) ${n().overallProgress}%,
      rgba(0, 0, 0, 0.7) 100%
    );
    height: 4px;
    transition: all 0.3s ease;
    opacity: ${s()?1:0};
    transform: translateY(${s()?"0":"-100%"});
  `),a=C(()=>`
    position: absolute;
    top: 6px;
    left: 8px;
    right: 8px;
    background: rgba(0, 0, 0, 0.8);
    color: white;
    font-size: 12px;
    padding: 4px 8px;
    border-radius: 4px;
    backdrop-filter: blur(4px);
    transition: all 0.3s ease;
    opacity: ${s()?1:0};
    transform: translateY(${s()?"0":"-100%"});
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `);return this.h`
    <div style=${_()} />
    <div style=${a()}>
      Caching ${n().fileCount} asset${n().fileCount!==1?"s":""}
      (${n().overallProgress}%): ${n().fileList}
    </div>
  `});export{vt as a,Nt as b,ft as c,Ae as d,cs as e,Ve as f};

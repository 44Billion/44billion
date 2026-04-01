import{b as Se,c as ie,d as Te}from"./chunk-FZKW7XBH.js";import{c as Me,d as ge,m as Ke,n as le}from"./chunk-KNJ2YI5P.js";import{a as re,e as V,f as Ae,g as Be,j as he,l as ae}from"./chunk-4YEM5IRY.js";import{a as H,b as F,f as J}from"./chunk-TBF35Z4Q.js";import{g as D,i as ye,j as ve,n as N,o as oe,p as Q,q as Ee,s as G,v as T}from"./chunk-EOHNSKYH.js";var _e="0123456789abcdefghijklmnopqrstuvwxyz",Fe=BigInt(_e.length),Ve=_e[0],je=new Map([..._e].map((t,e)=>[t,BigInt(e)]));function He(t,e=0){return Ie(re(t),e)}function Ie(t,e=0){return ze(Qe(t),e)}function mt(t,e=0){return He(Ae(t),e)}function xe(t){return Ye(qe(t))}function qe(t){if(typeof t!="string")throw new Error("Input must be a string.");let e=0n;for(let s of t){let n=je.get(s);if(n===void 0)throw new Error(`Invalid character in Base36 string: ${s}`);e=e*Fe+n}return e}function ze(t,e){if(typeof t!="bigint")throw new Error("Input must be a BigInt.");if(t<0n)throw new Error("Can't be signed BigInt");return t.toString(36).padStart(e,Ve)}function Ye(t){if(typeof t!="bigint")throw new Error("Input must be a BigInt.");if(t<0n)throw new Error("Can't be signed BigInt");let e=t.toString(16);return e.length%2!==0&&(e=`0${e}`),e}function Qe(t){if(typeof t!="string")throw new Error("Input must be a string.");return BigInt(`0x${t}`)}function Pe(t){if(t instanceof Error)return t;let e=new Error(t.message);return e.name=t.name||"Error",e.stack=t.stack,Object.assign(e,t.context||{}),e}var Oe=!1,Ge=Oe?"http://":"https://",Je=Oe?"localhost:10000":"44billion.net",bt=`${Ge}${Je}`;var X={};function Xe(){return Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)}function Ze(t,e,s=5e3){if(!t||!e)throw new Error("Missing request id or code");let{promise:n,resolve:p,reject:a}=Promise.withResolvers();X[t]={resolve:p,reject:a};let i;return s!=null&&(s>0?i=setTimeout(()=>{X[t]?.reject?.(`Timeout for ${e} reqId: ${t}`)},s):X[t]?.reject?.(`Timeout for ${e} reqId: ${t}`)),n.finally(()=>{clearTimeout(i),delete X[t]})}function et(t){let e=X[t.data.reqId];if(!e){console.log(`Unhandled response for reqId ${t.data.reqId} (may have timed out)`,JSON.stringify(t.data));return}t.data.error?e.reject(Pe(t.data.error)):e.resolve({payload:t.data.payload,isLast:t.data.isLast??!0,ports:t.ports})}var tt=((t,e=new WeakMap,s=new FinalizationRegistry(n=>n.abort()))=>n=>{let p=n instanceof MessagePort;if(t=p?n:globalThis,e.has(t))return;let a=new AbortController;e.set(t,a),t.addEventListener("message",async i=>{if(i.data.code==="REPLY")return et(i)},{signal:a.signal}),p&&t.start(),s.register(t,a)})();async function me(t,e,s,n){if(!e.code&&!("payload"in e))throw new Error("Missing args");(!s||typeof s!="object")&&(s={targetOrigin:s,transfer:n}),tt(t);let p=Xe(),a=Ze(p,e.code,s.timeout);return t.postMessage({...e,reqId:p},s),a.then(({payload:i,ports:c})=>({code:e.code,payload:i,ports:c})).catch(i=>({code:e.code,payload:null,error:i}))}function P(t,e,s,n){if(!("payload"in e)&&!("error"in e))throw new Error("Missing args");if((!s||typeof s!="object")&&(s={targetOrigin:s,transfer:n}),s.targetOrigin??=t.origin,!s.to&&!t.source)throw new Error("Set port to options.to");s.to??=t.source,s.to.postMessage({...e,reqId:t.data.reqId,code:"REPLY"},s)}function W(t,e,s,n){if(!e.code||!("payload"in e)&&!("error"in e))throw new Error("Missing args");(!s||typeof s!="object")&&(s={targetOrigin:s,transfer:n}),t.postMessage(e,s)}async function st(t,e,s){try{let n=s.map(r=>Ke(r)),p=new Blob(n,{type:e.contentType}),a=new FileReader,c=await new Promise((r,o)=>{a.onload=()=>r(a.result),a.onerror=o,a.readAsDataURL(p)}),_={fx:e.rootHash,url:c};return H(localStorage,`session_appById_${t}_icon`,_),_}catch(n){console.log("Failed to update icon storage:",n)}}async function Pt(t,e,s,n,p,a,i,c,_,r,o,{signal:y,isSingleNapp:w=!1}={}){let h=xe(t),u=V(h)===JSON.parse(localStorage.getItem("session_defaultUserPk")),$=new URL(JSON.parse(localStorage.getItem("config_vaultUrl")));document.querySelector(`iframe[src="${$.href.replace(/\/$/,"")}"]`)||console.warn("Vault iframe not found");let O=he(e),A=await le.create(e,O);w&&A.updateSiteManifestMetadata({lastOpenedAsSingleNappAt:Date.now()});let K=null,g=null;y?.addEventListener("abort",()=>{K&&(K.close(),K=null),g&&(g.close(),g=null)},{once:!0});let B,x=location.origin.replace("//",`//${s}.`);window.addEventListener("message",f=>{f.data.code!=="TRUSTED_IFRAME_READY"||f.source!==p.contentWindow||f.origin!==x||(B?.abort(),B=new AbortController,K&&K.close(),K=f.ports[0],be(K,AbortSignal.any([y,B.signal])),ee(s,n))},{signal:y});let S=!1;function ee(f,C=""){if(S)return;S=!0;let m;window.addEventListener("message",d=>{d.data.code!=="APP_IFRAME_READY"||d.source!==a.contentWindow||d.origin!==x||(m?.abort(),m=new AbortController,g&&g.close(),g=d.ports[0],Ne(g,AbortSignal.any([y,m.signal])))},{signal:y});let l=window.location.host;i(`//${f}.${l}${C}`)}function be(f,C){f.addEventListener("message",async m=>{switch(m.data.code){case"STREAM_APP_FILE":{let l=(d,k=new Error("FILE_NOT_CACHED"))=>(d&&console.log(d),P(m,{error:k,isLast:!0},{to:f}));try{let d=await A.getFileCacheStatus(m.data.payload.pathname,null,{withMeta:!0});if(!d.isCached)if(d.isHtml)l(null,new Error("HTML_FILE_NOT_CACHED"));else{let{fileRootHash:E,total:v}=d,b=0,M=!1,U=!1,q=!1,de=async()=>{if(!(M||U||q)){q=!0;try{for(;!M&&!U;){let L=await Me(e,E,{fromPos:b,toPos:b});if(L.length===0)break;let z=L[0];if(v===null){let se=z.evt.tags.find(ne=>ne[0]==="c"&&ne[1].startsWith(`${E}:`)),j=parseInt(se?.[2]);!Number.isNaN(j)&&j>0&&(v=j)}let Y=v!=null&&b===v-1;P(m,{payload:{content:z.evt.content,...b===0&&{contentType:d.contentType}},isLast:Y},{to:f}),b++,Y&&(U=!0)}}catch(L){M=!0,l(L)}finally{q=!1}}},We=async({progress:L,chunkIndex:z,total:Y,error:se})=>{if(M||U)return;if(se){M=!0;let pe=c(),{[m.data.payload.pathname]:De,...fe}=pe;return c(fe),l(se)}Y&&v===null&&(v=Y);let j=m.data.payload.pathname,ne=c();c({...ne,[j]:{progress:L,totalByteSizeEstimate:v?(v-1)*51e3:0}}),L>=100&&setTimeout(()=>{let pe=c(),{[j]:De,...fe}=pe;c(fe)},1e3),typeof z=="number"?z===b&&await de():await de()};try{if(await de(),!U&&!M)return A.cacheFile(m.data.payload.pathname,d.pathTag,We)}catch(L){return l(L)}}let k=0;for await(let E of ge(e,A.getFileRootHash(m.data.payload.pathname)))P(m,{payload:{content:E.evt.content,...k===0&&{contentType:d.contentType}},isLast:++k===d.total},{to:f})}catch(d){return l(d,d)}break}}},{signal:C}),f.start(),W(f,{code:"BROWSER_READY",payload:null})}let R=new Map,te=new Map;async function ue(f,C,{timeoutMs:m=1750}={}){if(R.has(f))return R.get(f);te.has(f)||te.set(f,{icon:!1,name:!1,promise:null});let l=te.get(f);if(l.promise)return l.promise;C??=he(f);let d=await le.create(f,C),k={id:f,napp:Se(C)},E=[];!("icon"in k)&&!l.icon&&(l.icon=!0,E.push(d.getIcon().then(b=>b&&(k.icon=b)).finally(()=>{l.icon=!1}))),!("name"in k)&&!l.name&&(l.name=!0,E.push(d.getName().then(b=>b&&(k.name=b)).finally(()=>{l.name=!1})));let v=(async()=>{if(E.length>0){let b=Promise.all(E).then(()=>R.set(f,k));await Promise.race([b,new Promise(M=>setTimeout(M,m))])}return R.set(f,k),te.delete(f),k})();return l.promise=v,v}function Ne(f,C){f.addEventListener("message",async m=>{switch(m.data.code){case"OPEN_APP":{let l;try{let{href:d}=m.data.payload,E=new URL(d,self.location.origin).pathname,v=/^\/(\+{1,3}[a-zA-Z0-9]{48,})/,b=E.match(v);if(!b){console.error("Invalid app URL format:",d);break}let M=b[1],U=ie(M);l=ae(U);let q=await ue(l,U,{timeoutMs:0});await r({app:await ue(e,O),name:"openApp",eKind:null,meta:{targetApp:q}}),o(d)}catch(d){let k=!1;for(let E of JSON.parse(localStorage.getItem("session_workspaceKeys"))??[])if(k=Array.isArray(JSON.parse(localStorage.getItem(`session_workspaceByKey_${E}_appById_${l}_appKeys`))),k)break;k||(H(localStorage,`session_appById_${l}_icon`,void 0),H(localStorage,`session_appById_${l}_name`,void 0),H(localStorage,`session_appById_${l}_description`,void 0),H(localStorage,`session_appById_${l}_relayHints`,void 0),await(await le.create(l)).clearAppFiles()),console.error("Error in OPEN_APP handler:",d)}break}case"NIP07":{if(["peek_public_key","get_public_key"].includes(m.data.payload.method)&&m.data.payload.ns[0]===""&&m.data.payload.ns.length===1){P(m,{payload:h},{to:f});break}let{ns:l,method:d,params:k=[]}=m.data.payload,E=await ue(e,O,{timeoutMs:0}),v;try{v=await at(_,h,l,d,k,{isDefaultUser:u,requestPermission:r,app:E})}catch(b){v={error:b}}P(m,v,{to:f});break}case"WINDOW_NAPP":{nt(m);break}case"STREAM_APP_ICON":{try{let l=A.getFaviconMetadata();if(!l){P(m,{error:new Error("No favicon"),isLast:!0},{to:f});break}let d=await A.getFileCacheStatus(null,l.tag,{withMeta:!0});d.isCached||(await A.cacheFile(null,l.tag),d=await A.getFileCacheStatus(null,l.tag,{withMeta:!0}));let E=JSON.parse(localStorage.getItem(`session_appById_${e}_icon`))?.fx!==l.rootHash,v=[],b=0;for await(let M of ge(e,l.rootHash))E&&v.push(M.evt.content),P(m,{payload:{content:M.evt.content,...b===0&&{mimeType:l.mimeType||d.mimeType,contentType:l.contentType||d.contentType}},isLast:++b===d.total},{to:f});if(v.length>0){let{url:M}=await st(e,l,v);if(R.has(e)){let U=R.get(e);U.icon={fx:l.rootHash,url:M}}}}catch(l){console.log(l.stack),P(m,{error:l,isLast:!0},{to:f})}break}case"CACHE_APP_FILE":{try{let l=({progress:d,error:k})=>{if(k)P(m,{error:k,isLast:!0},{to:f});else{let E=d>=100;P(m,{payload:d,isLast:E},{to:f})}};A.cacheFile(m.data.payload.pathname,null,l)}catch(l){console.log(m.data.payload.pathname,"error:",l.stack),P(m,{error:l,isLast:!0},{to:f})}break}}},{signal:C}),f.start(),W(f,{code:"BROWSER_READY",payload:null})}}function nt(t){return P(t,{error:new Error("Not implemented yet")})}var ot={getPublicKey:"readProfile",signEvent:"signEvent",nip04Encrypt:"encrypt",nip04Decrypt:"decrypt",nip44Encrypt:"encrypt",nip44Decrypt:"decrypt"};function rt(t){return ot[t]||(()=>{throw new Error(`Unknown method ${t}`)})()}async function at(t,e,s,n,p,{isDefaultUser:a,requestPermission:i,app:c}={}){if(a)throw new Error("Please login");if(i){let y=n.includes("_")?n.replace(/_([a-z0-9])/g,(h,u)=>u.toUpperCase()):n,w=(()=>{switch(y){case"signEvent":return p?.[0]?.kind;default:return null}})();await i({app:c,name:rt(y),eKind:w,meta:{params:p}})}let{napp:_,...r}=c,o={code:"NIP07",payload:{app:{...r,id:_},pubkey:e,ns:s,method:n,params:p}};return t(o,{timeout:12e4})}function we(){return V(it(),43)}function it(){let t=crypto.getRandomValues(new Uint8Array(40)),s=2n**256n-0x14551231950b75fc4402da1732fc9bebfn;return(((i,c)=>{let _=i%c;return _>=0n?_:c+_})((i=>BigInt("0x"+(re(i)||"0")))(t),s-1n)+1n).toString(16).padStart(64,"0")}var Ue=["+32Wp7Qdz5XIbjlzHht7GdEP8IDxk6CC90ee8lRxYjx0stjsVD8yzTguF","+3swFhu23QNl8er5yOtc8bf9ueHCdwF8CzoDUiSSwwKIWoS8Ki5TwMyeA3Js1"].map(ie).map(ae);function lt(){let t=F(localStorage),e=F(sessionStorage);return Ee("hardcoded_newAppIdsObj",{}),T(()=>{if(t.session_workspaceKeys$())return;let s=we();t.session_defaultUserPk$(s),Re({userPk:s,storage:t,tabStorage:e,isFirstTimeUser:!0})}),T(()=>{if(!t.session_workspaceKeys$())return;let s=t.session_workspaceKeys$()||[],n=t.session_defaultUserPk$();s.forEach(p=>{let a=t[`session_workspaceByKey_${p}_userPk$`]();a!=null&&a!==n&&!(t[`session_accountByUserPk_${a}_isReadOnly$`]()??!1)&&t[`session_accountByUserPk_${a}_isLocked$`](!0)})}),T(({track:s})=>{if(s(()=>t.session_workspaceKeys$().length>0))return;let n=we();t.session_defaultUserPk$(n),Re({userPk:n,storage:t,tabStorage:e,isFirstTimeUser:!0})}),t}function Re({userPk:t,storage:e,tabStorage:s,isFirstTimeUser:n}){let p=Ue.map((c,_)=>({id:c,key:Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),visibility:"closed",isNew:!1})),a=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);e.config_isSingleWindow$()===void 0&&e.config_isSingleWindow$(!1);let i=[];s[`session_workspaceByKey_${a}_openAppKeys$`](i),e[`session_workspaceByKey_${a}_userPk$`](t),p.forEach(c=>{e[`session_workspaceByKey_${a}_appById_${c.id}_appKeys$`]([c.key]),e[`session_appByKey_${c.key}_id$`](c.id),s[`session_appByKey_${c.key}_visibility$`](c.visibility),e[`session_appByKey_${c.key}_route$`]("")}),e[`session_workspaceByKey_${a}_unpinnedCoreAppIdsObj$`]({}),e[`session_workspaceByKey_${a}_pinnedAppIds$`](p.map(({id:c})=>c)),e[`session_workspaceByKey_${a}_unpinnedAppIds$`]([]),e[`session_accountByUserPk_${t}_isReadOnly$`](!0),e[`session_accountByUserPk_${t}_isLocked$`](!1),e[`session_accountByUserPk_${t}_profile$`]({npub:Te(Be(t)),meta:{events:[]}}),e[`session_accountByUserPk_${t}_relays$`]({meta:{events:[]}}),e.session_accountUserPks$([t]),e.session_workspaceKeys$([a]),e.session_openWorkspaceKeys$([a])}async function $e(t,e,s){let n=e.session_workspaceKeys$()||[],p=e.session_openWorkspaceKeys$()||[],a=e.session_defaultUserPk$(),i=n.length===1&&n.every(o=>e[`session_workspaceByKey_${o}_userPk$`]()===a);if(t.length===0&&i)return;let c=e.session_accountUserPks$()||[],_=t.map(o=>V(o.pubkey)),r;if(t.forEach(o=>{let y=V(o.pubkey);e[`session_accountByUserPk_${y}_isReadOnly$`](r=o.isReadOnly??!1),e[`session_accountByUserPk_${y}_isLocked$`](r?!1:o.isLocked??!0),e[`session_accountByUserPk_${y}_profile$`](o.profile),e[`session_accountByUserPk_${y}_relays$`](o.relays)}),i&&_.length===1){let o=n[0],y=_[0],w=s[`session_workspaceByKey_${o}_openAppKeys$`]()||[],h=[];w.forEach(u=>{s[`session_appByKey_${u}_visibility$`]($=>($==="open"&&h.push(u),"closed"))}),s[`session_workspaceByKey_${o}_openAppKeys$`]([]),e[`session_workspaceByKey_${o}_userPk$`](y),await new Promise(u=>setTimeout(u,0)),h.forEach(u=>{s[`session_appByKey_${u}_visibility$`]("open")}),s[`session_workspaceByKey_${o}_openAppKeys$`](h),e.session_defaultUserPk$(void 0)}else{let o=_.filter(g=>!c.includes(g)),y=c.filter(g=>!_.includes(g));o.length>0&&a&&e.session_defaultUserPk$(void 0);let w=[];for(let g of y)w=w.concat(n.filter(B=>e[`session_workspaceByKey_${B}_userPk$`]()===g));let h=[];for(let g of o){let B=Ue.map(S=>({id:S,key:Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),visibility:"closed",isNew:!1})),x=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);h.push(x),s[`session_workspaceByKey_${x}_openAppKeys$`]([]),e[`session_workspaceByKey_${x}_userPk$`](g),B.forEach(S=>{e[`session_workspaceByKey_${x}_appById_${S.id}_appKeys$`]([S.key]),e[`session_appByKey_${S.key}_id$`](S.id),s[`session_appByKey_${S.key}_visibility$`](S.visibility),e[`session_appByKey_${S.key}_route$`]("")}),e[`session_workspaceByKey_${x}_unpinnedCoreAppIdsObj$`]({}),e[`session_workspaceByKey_${x}_pinnedAppIds$`](B.map(({id:S})=>S)),e[`session_workspaceByKey_${x}_unpinnedAppIds$`]([])}let u=new Set(w),$=n.filter(g=>!u.has(g)).concat(h),I=new Set($),O=p.filter(g=>I.has(g)),A=new Set(O),K=O.concat($.filter(g=>!A.has(g)));e.session_openWorkspaceKeys$(K),e.session_workspaceKeys$($);for(let g of w){let B=e[`session_workspaceByKey_${g}_pinnedAppIds$`]()||[],x=e[`session_workspaceByKey_${g}_unpinnedAppIds$`]()||[],S=[...new Set([...B,...x])];e[`session_workspaceByKey_${g}_unpinnedCoreAppIdsObj$`](void 0),e[`session_workspaceByKey_${g}_pinnedAppIds$`](void 0),e[`session_workspaceByKey_${g}_unpinnedAppIds$`](void 0),e[`session_workspaceByKey_${g}_userPk$`](void 0),s[`session_workspaceByKey_${g}_openAppKeys$`](void 0),S.forEach(ee=>{(e[`session_workspaceByKey_${g}_appById_${ee}_appKeys$`]()||[]).forEach(R=>{e[`session_appByKey_${R}_id$`](void 0),s[`session_appByKey_${R}_visibility$`](void 0),e[`session_appByKey_${R}_route$`](void 0)}),e[`session_workspaceByKey_${g}_appById_${ee}_appKeys$`](void 0)})}}e.session_accountUserPks$(_),c.filter(o=>!_.includes(o)).forEach(o=>{e[`session_accountByUserPk_${o}_isReadOnly$`](void 0),e[`session_accountByUserPk_${o}_isLocked$`](void 0),e[`session_accountByUserPk_${o}_profile$`](void 0),e[`session_accountByUserPk_${o}_relays$`](void 0)})}var Yt=D("aModal",function(){let t=oe({dialogRef$:null,render:this.props.render,shouldAlwaysDisplay$:this.props.shouldAlwaysDisplay$??this.props.shouldAlwaysDisplay??!1,isOpen$:this.props.isOpen$,close:this.props.close,afterClose:this.props.afterClose});return T(({track:e})=>{e(()=>t.isOpen$.get())?t.dialogRef$().showModal():t.dialogRef$().close()},{after:"rendering"}),this.h`
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

              @media ${J.breakpoints.desktop} {
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

              @media ${J.breakpoints.mobile} {
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

                @media ${J.breakpoints.desktop} {
                  border-radius: 17px;
                  min-width: 400px;
                  width: 800px;
                  max-width: 90vw;
                  max-width: 90dvw;
                  max-height: 90vh; /* leave 10 for browser collapsible header */
                  max-height: 90dvh;
                }

                @media ${J.breakpoints.mobile} {
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
  `},{useShadowDOM:!1});function ke(t){return t?ct(t):G("<a-modal>")}function ct(t){return G("<a-modal>",t)}D("vaultModal",function(){let t=ke(),e=oe(()=>({...t,shouldAlwaysDisplay$:!0,render:ye(function(){return this.h`<vault-messenger-wrapper />`})}));return this.h`<a-modal props=${e} />`});D("vault-messenger-wrapper",function(){let t=F(localStorage),{config_vaultUrl$:e}=t;T(()=>{e()===void 0&&e("https://44billion.github.io/44b-vault")});let s=ve(!1);T(async({track:p,cleanup:a})=>{let i=p(()=>e());if(!i){s(!1);return}s(!1);let c=0,_,r=new AbortController;a(()=>{clearTimeout(_),r.abort()});let o=async()=>{try{if(await fetch(i,{mode:"no-cors",signal:r.signal}),r.signal.aborted)return;s(!0)}catch{if(r.signal.aborted)return;c++;let w=Math.min(3e4,500*2**c);console.warn(`Vault unreachable, retrying in ${w}ms`),_=setTimeout(o,w)}};o()},{after:"rendering"});let{vaultPort$:n}=Ce({shouldInit:!0});return Le(n),!e()||!s()?this.h``:this.h`${this.h({key:e()})`<vault-messenger />`}`});function Ce({shouldInit:t=!1}={}){return t?Q("vaultMessenger",()=>({isWorkarounEnabled$:!0,disableStartAtVaultHomeWorkaroundThisTime(){this.isWorkarounEnabled$(!1)},isFirstRun$:!0,vaultPort$:null,vaultIframeRef$:null,vaultIframeSrc$:"about:blank",isVaultMessengerReady$:!1,widgetHeight$:0})):Q("vaultMessenger")}D("vault-messenger",function(){let{isFirstRun$:t,vaultPort$:e,vaultIframeRef$:s,vaultIframeSrc$:n,isVaultMessengerReady$:p,widgetHeight$:a,isWorkarounEnabled$:i}=Ce();T(({cleanup:u})=>u(()=>{e(null),n("about:blank")}));let c=F(localStorage),_=F(sessionStorage),{config_vaultUrl$:r}=c,{cancelPreviousRequests:o,postVaultMessage:y}=Le(e),w=ke(),{isOpen$:h}=w;return T(({track:u})=>{let $=u(()=>h());t()||$||e()&&y({code:"CLOSED_VAULT_VIEW",payload:null},{instant:!0})}),T(({track:u})=>{let $=i();i(!0);let I=u(()=>!h());t()||I||!$||e()&&y({code:"OPEN_VAULT_HOME",payload:null},{instant:!0})}),T(()=>{t(!1)}),T(async({track:u,cleanup:$})=>{u(()=>r());let I=new AbortController;$(()=>{I.abort()});let O=new URL(r()).origin,A,K=()=>{A&&A.abort()},g=B=>{A=B,B&&B.signal.addEventListener("abort",()=>{A===B&&(A=null)},{once:!0})};s().addEventListener("load",()=>{setTimeout(()=>{K();let B=pt({vaultIframe:s(),vaultPort$:e,abortSignal:I.signal});g(B)},100)},{signal:I.signal}),dt({vaultIframe:s(),vaultOrigin:O,vaultPort$:e,componentSignal:I.signal,widgetHeight$:a,storage:c,tabStorage:_,stopRenderHandshake:K,vaultModalStore:w}),p(!0)},{after:"rendering"}),T(async({track:u})=>{let[$,I]=u(()=>[p(),r()]);$&&(n(I),o(new Error("Canceled due to new vault URL selection")))}),this.h`
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
  `});var Z=null,ce=[],ut=50;function ts(t){if(!Z){ce.length<ut&&ce.push(t);return}W(Z,t)}function dt({vaultIframe:t,vaultOrigin:e,vaultPort$:s,componentSignal:n,widgetHeight$:p,storage:a,tabStorage:i,stopRenderHandshake:c,vaultModalStore:_}){let r=null;n?.addEventListener("abort",()=>{r&&(r.close(),r=null,Z=null,ce.length=0)},{once:!0});let o;window.addEventListener("message",h=>{h.data.code!=="VAULT_READY"||h.source!==t.contentWindow||h.origin!==e||!h.ports[0]||(h.data.payload.accounts?$e(h.data.payload.accounts,a,i):console.log("Missing account data on vault startup"),o?.abort(),o=new AbortController,r&&r.close(),r=h.ports[0],Z=r,ce.splice(0).forEach(u=>W(Z,u)),y({vaultPort:r,signal:AbortSignal.any([n,o.signal])}),c?.(),w(r),s(r))},{signal:n});function y({vaultPort:h,signal:u}){h.addEventListener("message",$=>{switch($.data.code){case"CHANGE_DIMENSIONS":{p($.data.payload.height);break}case"CLOSE_VAULT_VIEW":{_.close();break}case"SET_ACCOUNTS_STATE":{if(!$.data.payload.accounts){console.log("Missing account data on vault message");break}$e($.data.payload.accounts,a,i);break}}},{signal:u}),h.start()}function w(h){W(h,{code:"BROWSER_READY",payload:null})}}function pt({vaultIframe:t,vaultPort$:e,abortSignal:s}){if(s?.aborted)return null;let n=new AbortController,{signal:p}=n,a,i=()=>{n.signal.aborted||n.abort()};s&&s.addEventListener("abort",i,{once:!0}),p.addEventListener("abort",()=>{a&&clearTimeout(a)},{once:!0});let c=40,_=0,r=()=>{if(p.aborted)return;let o=t?.contentWindow;if(!o){i();return}if(W(o,{code:"RENDER",payload:null},{targetOrigin:"*"}),e()){i();return}if(_>=c){i();return}_+=1;let y=Math.min(500,50*_);a=setTimeout(r,y)};return r(),n}function Le(t){return t!==void 0&&ft(t),Q("useRequestVaultMessage")}function ft(t){let e=F(localStorage),{config_vaultUrl$:s}=e,{msgQueue$:n}=Q("useRequestVaultMessage",()=>({vaultPort$:t,vaultOrigin$(){return new URL(s()).origin},msgQueue$:{waiting:[],running:[]},postVaultMessage(r){if(!this.vaultPort$())return Promise.reject(new Error("Vault not connected"));W(this.vaultPort$(),r)},async requestVaultMessage(r,{timeout:o,instant:y=!1}={}){if(y)return this.vaultPort$()?me(this.vaultPort$(),r,{...o!=null&&{timeout:o}}):Promise.reject(new Error("Vault not connected"));let w=Date.now(),h=Promise.withResolvers();return h.promise.finally(()=>{this.msgQueue$(u=>(u.running=u.running.filter($=>$.p!==h),{...u}))}),this.msgQueue$(u=>(u.waiting.push({msg:r,timeout:o,queuedAt:w,p:h}),{...u})),h.promise},cancelPreviousRequests(r){this.msgQueue$().running.forEach(o=>o.p.resolve({code:o.msg.code,payload:null,error:r||new Error("Canceled")}))}})),p=ke(),{session_openWorkspaceKeys$:a}=e,i=N(()=>{let r=a()[0];return e[`session_workspaceByKey_${r}_userPk$`]()}),c=N(()=>i()!==e.session_defaultUserPk$()||a().length>1),_=ye(r=>c()?!1:(p.open(),r.p.resolve({code:r.msg.code,payload:null,error:new Error("Not logged in")}),!0));T(({track:r})=>{let[o,y]=r(()=>[n(),t()]);if(!y)return;let w=Math.min(5-o.running.length,o.waiting.length),h=Date.now();for(let u=0;u<w;u++){let $=o.waiting.shift();if(o.running.push($),_($))return;let{msg:I,timeout:O,queuedAt:A,p:K}=o.running[o.running.length-w+u];me(y,I,{...O!=null&&{timeout:A+O-h}}).then(g=>{K.resolve(g)})}})}D("nappAssetsCachingProgressBar",function(){let t;try{({cachingProgress$:t}=G("<napp-assets-caching-progress-bar>"))}catch(i){console.warn("No cachingProgress$ store found",i);return}let e=N(()=>Object.entries(t()).filter(([i])=>!i.startsWith("_")&&(i.startsWith("/")||i.includes(".")))),s=N(()=>e().length>0),n=N(()=>{let i=e();if(i.length===0)return{overallProgress:0,fileList:"",fileCount:0};let c=i.reduce((y,[w,h])=>y+h.progress,0),_=Math.round(c/i.length),r=i.map(([y])=>{let w=y.split("/").pop()||y;return w.length>20?w.slice(0,17)+"...":w}),o=r.length>3?r.slice(0,3).join(", ")+`... (+${r.length-3} more)`:r.join(", ");return{overallProgress:_,fileList:o,fileCount:i.length}}),p=N(()=>`
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
  `),a=N(()=>`
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
    <div style=${p()} />
    <div style=${a()}>
      Caching ${n().fileCount} asset${n().fileCount!==1?"s":""}
      (${n().overallProgress}%): ${n().fileList}
    </div>
  `});export{mt as a,Pt as b,lt as c,ke as d,ts as e,Le as f};

import{b as Ee,c as ne,d as Ae}from"./chunk-4NYNH44B.js";import{d as Se,e as ce,m as Me,n as oe}from"./chunk-DF4IVW5S.js";import{a as ke,e as N,g as be,i as ve,l as le,n as se}from"./chunk-YCNW34TK.js";import{a as j,b as V,f as J}from"./chunk-KN6GOQRR.js";import{h as C,j as ie,k as $e,o as I,p as te,q as Y,r as we,t as Q,w as B}from"./chunk-K2UKPH6Q.js";function Be(t){if(t instanceof Error)return t;let e=new Error(t.message);return e.name=t.name||"Error",e.stack=t.stack,Object.assign(e,t.context||{}),e}var Ke=!1,Le=Ke?"http://":"https://",Ne=Ke?"localhost:10000":"44billion.net",nt=`${Le}${Ne}`;var G={};function We(){return Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)}function De(t,e,s=5e3){if(!t||!e)throw new Error("Missing request id or code");let{promise:r,resolve:i,reject:c}=Promise.withResolvers();G[t]={resolve:i,reject:c};let o;return s!=null&&(s>0?o=setTimeout(()=>{G[t]?.reject?.(`Timeout for ${e} reqId: ${t}`)},s):G[t]?.reject?.(`Timeout for ${e} reqId: ${t}`)),r.finally(()=>{clearTimeout(o),delete G[t]})}function Fe(t){let e=G[t.data.reqId];if(!e){console.log(`Unhandled response for reqId ${t.data.reqId} (may have timed out)`,JSON.stringify(t.data));return}t.data.error?e.reject(Be(t.data.error)):e.resolve({payload:t.data.payload,isLast:t.data.isLast??!0,ports:t.ports})}var je=((t,e=new WeakMap,s=new FinalizationRegistry(r=>r.abort()))=>r=>{let i=r instanceof MessagePort;if(t=i?r:globalThis,e.has(t))return;let c=new AbortController;e.set(t,c),t.addEventListener("message",async o=>{if(o.data.code==="REPLY")return Fe(o)},{signal:c.signal}),i&&t.start(),s.register(t,c)})();async function ue(t,e,s,r){if(!e.code&&!("payload"in e))throw new Error("Missing args");(!s||typeof s!="object")&&(s={targetOrigin:s,transfer:r}),je(t);let i=We(),c=De(i,e.code,s.timeout);return t.postMessage({...e,reqId:i},s),c.then(({payload:o,ports:d})=>({code:e.code,payload:o,ports:d})).catch(o=>({code:e.code,payload:null,error:o}))}function O(t,e,s,r){if(!("payload"in e)&&!("error"in e))throw new Error("Missing args");if((!s||typeof s!="object")&&(s={targetOrigin:s,transfer:r}),s.targetOrigin??=t.origin,!s.to&&!t.source)throw new Error("Set port to options.to");s.to??=t.source,s.to.postMessage({...e,reqId:t.data.reqId,code:"REPLY"},s)}function W(t,e,s,r){if(!e.code||!("payload"in e)&&!("error"in e))throw new Error("Missing args");(!s||typeof s!="object")&&(s={targetOrigin:s,transfer:r}),t.postMessage(e,s)}async function Ve(t,e,s){try{let r=s.map(n=>Me(n)),i=new Blob(r,{type:e.contentType}),c=new FileReader,d=await new Promise((n,l)=>{c.onload=()=>n(c.result),c.onerror=l,c.readAsDataURL(i)}),p={fx:e.rootHash,url:d};return j(localStorage,`session_appById_${t}_icon`,p),p}catch(r){console.log("Failed to update icon storage:",r)}}async function yt(t,e,s,r,i,c,o,d,p,n,l,{signal:m,isSingleNapp:u=!1}={}){let h=ve(t),g=N(h)===JSON.parse(localStorage.getItem("session_defaultUserPk")),A=new URL(JSON.parse(localStorage.getItem("config_vaultUrl")));document.querySelector(`iframe[src="${A.href.replace(/\/$/,"")}"]`)||console.warn("Vault iframe not found");let K=le(e),S=await oe.create(e,K);u&&S.updateBundleMetadata({lastOpenedAsSingleNappAt:Date.now()});let _=null,k=null;m?.addEventListener("abort",()=>{_&&(_.close(),_=null),k&&(k.close(),k=null)},{once:!0});let T,M=location.origin.replace("//",`//${s}.`);window.addEventListener("message",y=>{y.data.code!=="TRUSTED_IFRAME_READY"||y.source!==i.contentWindow||y.origin!==M||(T?.abort(),T=new AbortController,_&&_.close(),_=y.ports[0],H(_,AbortSignal.any([m,T.signal])),ye(s,r))},{signal:m});let q=!1;function ye(y,U=""){if(q)return;q=!0;let $;window.addEventListener("message",f=>{f.data.code!=="APP_IFRAME_READY"||f.source!==c.contentWindow||f.origin!==M||($?.abort(),$=new AbortController,k&&k.close(),k=f.ports[0],Re(k,AbortSignal.any([m,$.signal])))},{signal:m});let a=window.location.host;o(`//${y}.${a}${U}`)}function H(y,U){y.addEventListener("message",async $=>{switch($.data.code){case"STREAM_APP_FILE":{let a=(f,b=new Error("FILE_NOT_CACHED"))=>(f&&console.log(f),O($,{error:b,isLast:!0},{to:y}));try{let f=await S.getFileCacheStatus($.data.payload.pathname,null,{withMeta:!0});if(!f.isCached)if(f.isHtml)a(null,new Error("HTML_FILE_NOT_CACHED"));else{let{fileRootHash:E,total:v}=f,w=0,P=-1,x=!1,z=!1,Ue=async({progress:Z,newlyCachedChunkIndexRanges:he,error:_e})=>{if(x||z)return;if(_e){x=!0;let R=d(),{[$.data.payload.pathname]:ee,...F}=R;return d(F),a(_e)}let me=$.data.payload.pathname,Ie=d();if(d({...Ie,[me]:{progress:Z,totalByteSizeEstimate:v?(v-1)*51e3:0}}),Z>=100&&setTimeout(()=>{let R=d(),{[me]:ee,...F}=R;d(F)},1e3),he.length>0)for(let R of he)P=Math.max(P,R[1]);else if(v!==null)P=v-1;else return a(new Error("No cached chunks"));for(;w<=P&&!x&&!z;)try{let R=await Se(e,E,{fromPos:w,toPos:w});if(R.length===0)return x=!0,a(new Error(`Missing chunk at index ${w} for rootHash ${E}`));let ee=R[0];if(v===null){let Ce=ee.evt.tags.find(ge=>ge[0]==="c"&&ge[1].startsWith(`${E}:`)),ae=parseInt(Ce?.[2]);!Number.isNaN(ae)&&ae>0&&(v=ae)}if(v===null)return x=!0,a(new Error("Unable to determine total chunks."));let F=v!=null&&w===v-1;O($,{payload:{content:ee.evt.content,...w===0&&{contentType:f.contentType}},isLast:F},{to:y}),w++,F&&(z=!0)}catch(R){return x=!0,a(R)}};try{return S.cacheFile($.data.payload.pathname,f.fileTag,Ue)}catch(Z){return a(Z)}}let b=0;for await(let E of ce(e,S.getFileRootHash($.data.payload.pathname)))O($,{payload:{content:E.evt.content,...b===0&&{contentType:f.contentType}},isLast:++b===f.total},{to:y})}catch(f){return a(f,f)}break}}},{signal:U}),y.start(),W(y,{code:"BROWSER_READY",payload:null})}let D=new Map,X=new Map;async function re(y,U,{timeoutMs:$=1750}={}){if(D.has(y))return D.get(y);X.has(y)||X.set(y,{icon:!1,name:!1,promise:null});let a=X.get(y);if(a.promise)return a.promise;U??=le(y);let f=await oe.create(y,U),b={id:y,napp:Ee(U)},E=[];!("icon"in b)&&!a.icon&&(a.icon=!0,E.push(f.getIcon().then(w=>w&&(b.icon=w)).finally(()=>{a.icon=!1}))),!("name"in b)&&!a.name&&(a.name=!0,E.push(f.getName().then(w=>w&&(b.name=w)).finally(()=>{a.name=!1})));let v=(async()=>{if(E.length>0){let w=Promise.all(E).then(()=>D.set(y,b));await Promise.race([w,new Promise(P=>setTimeout(P,$))])}return D.set(y,b),X.delete(y),b})();return a.promise=v,v}function Re(y,U){y.addEventListener("message",async $=>{switch($.data.code){case"OPEN_APP":{let a;try{let{href:f}=$.data.payload,E=new URL(f,self.location.origin).pathname,v=/^\/(\+{1,3}[a-zA-Z0-9]{48,})/,w=E.match(v);if(!w){console.error("Invalid app URL format:",f);break}let P=w[1],x=ne(P);a=se(x);let z=await re(a,x,{timeoutMs:0});await n({app:await re(e,K),name:"openApp",eKind:null,meta:{targetApp:z}}),l(f)}catch(f){let b=!1;for(let E of JSON.parse(localStorage.getItem("session_workspaceKeys"))??[])if(b=Array.isArray(JSON.parse(localStorage.getItem(`session_workspaceByKey_${E}_appById_${a}_appKeys`))),b)break;b||(j(localStorage,`session_appById_${a}_icon`,void 0),j(localStorage,`session_appById_${a}_name`,void 0),j(localStorage,`session_appById_${a}_description`,void 0),j(localStorage,`session_appById_${a}_relayHints`,void 0),await(await oe.create(a)).clearAppFiles()),console.error("Error in OPEN_APP handler:",f)}break}case"NIP07":{if(["peek_public_key","get_public_key"].includes($.data.payload.method)&&$.data.payload.ns[0]===""&&$.data.payload.ns.length===1){O($,{payload:h},{to:y});break}let{ns:a,method:f,params:b=[]}=$.data.payload,E=await re(e,K,{timeoutMs:0}),v;try{v=await Ye(p,h,a,f,b,{isDefaultUser:g,requestPermission:n,app:E})}catch(w){v={error:w}}O($,v,{to:y});break}case"WINDOW_NAPP":{qe($);break}case"STREAM_APP_ICON":{try{let a=S.getFaviconMetadata();if(!a){O($,{error:new Error("No favicon"),isLast:!0},{to:y});break}let f=await S.getFileCacheStatus(null,a.tag,{withMeta:!0});f.isCached||(await S.cacheFile(null,a.tag),f=await S.getFileCacheStatus(null,a.tag,{withMeta:!0}));let E=JSON.parse(localStorage.getItem(`session_appById_${e}_icon`))?.fx!==a.rootHash,v=[],w=0;for await(let P of ce(e,a.rootHash))E&&v.push(P.evt.content),O($,{payload:{content:P.evt.content,...w===0&&{mimeType:a.mimeType||f.mimeType,contentType:a.contentType||f.contentType}},isLast:++w===f.total},{to:y});if(v.length>0){let{url:P}=await Ve(e,a,v);if(D.has(e)){let x=D.get(e);x.icon={fx:a.rootHash,url:P}}}}catch(a){console.log(a.stack),O($,{error:a,isLast:!0},{to:y})}break}case"CACHE_APP_FILE":{try{let a=({progress:f,error:b})=>{if(b)O($,{error:b,isLast:!0},{to:y});else{let E=f>=100;O($,{payload:f,isLast:E},{to:y})}};S.cacheFile($.data.payload.pathname,null,a)}catch(a){console.log($.data.payload.pathname,"error:",a.stack),O($,{error:a,isLast:!0},{to:y})}break}}},{signal:U}),y.start(),W(y,{code:"BROWSER_READY",payload:null})}}function qe(t){return O(t,{error:new Error("Not implemented yet")})}var He={getPublicKey:"readProfile",signEvent:"signEvent",nip04Encrypt:"encrypt",nip04Decrypt:"decrypt",nip44Encrypt:"encrypt",nip44Decrypt:"decrypt"};function ze(t){return He[t]||(()=>{throw new Error(`Unknown method ${t}`)})()}async function Ye(t,e,s,r,i,{isDefaultUser:c,requestPermission:o,app:d}={}){if(c)throw new Error("Please login");if(o){let m=r.includes("_")?r.replace(/_([a-z0-9])/g,(h,g)=>g.toUpperCase()):r,u=(()=>{switch(m){case"signEvent":return i?.[0]?.kind;default:return null}})();await o({app:d,name:ze(m),eKind:u,meta:{params:i}})}let{napp:p,...n}=d,l={code:"NIP07",payload:{app:{...n,id:p},pubkey:e,ns:s,method:r,params:i}};return t(l,{timeout:12e4})}function de(){return N(Qe(),43)}function Qe(){let t=crypto.getRandomValues(new Uint8Array(40)),s=2n**256n-0x14551231950b75fc4402da1732fc9bebfn;return(((o,d)=>{let p=o%d;return p>=0n?p:d+p})((o=>BigInt("0x"+(ke(o)||"0")))(t),s-1n)+1n).toString(16).padStart(64,"0")}var Pe=["+32Wp7Qdz5XIbjlzHht7GdEP8IDxk6CC90ee8lRxYjx0stjsVD8yzTguF","+cA99KnC0UCyqHT5oI8fIkoza0jfB1lrvaWKmuh6h2EhTz2nw4R2a5qVNM"].map(ne).map(se);function Je(){let t=V(localStorage);return we("hardcoded_newAppIdsObj",{}),B(()=>{if(t.session_workspaceKeys$())return;let e=de();t.session_defaultUserPk$(e),Te({userPk:e,storage:t,isFirstTimeUser:!0})}),B(()=>{if(!t.session_workspaceKeys$())return;let e=t.session_workspaceKeys$()||[],s=t.session_defaultUserPk$();e.forEach(r=>{let i=t[`session_workspaceByKey_${r}_userPk$`]();i!=null&&i!==s&&!(t[`session_accountByUserPk_${i}_isReadOnly$`]()??!1)&&t[`session_accountByUserPk_${i}_isLocked$`](!0)})}),B(({track:e})=>{if(e(()=>t.session_workspaceKeys$().length>0))return;let s=de();t.session_defaultUserPk$(s),Te({userPk:s,storage:t,isFirstTimeUser:!0})}),t}function Te({userPk:t,storage:e,isFirstTimeUser:s}){let r=Pe.map((o,d)=>({id:o,key:Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),visibility:"closed",isNew:!1})),i=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);e.config_isSingleWindow$()===void 0&&e.config_isSingleWindow$(!1);let c=[];e[`session_workspaceByKey_${i}_openAppKeys$`](c),e[`session_workspaceByKey_${i}_userPk$`](t),r.forEach(o=>{e[`session_workspaceByKey_${i}_appById_${o.id}_appKeys$`]([o.key]),e[`session_appByKey_${o.key}_id$`](o.id),e[`session_appByKey_${o.key}_visibility$`](o.visibility),e[`session_appByKey_${o.key}_route$`]("")}),e[`session_workspaceByKey_${i}_unpinnedCoreAppIdsObj$`]({}),e[`session_workspaceByKey_${i}_pinnedAppIds$`](r.map(({id:o})=>o)),e[`session_workspaceByKey_${i}_unpinnedAppIds$`]([]),e[`session_accountByUserPk_${t}_isReadOnly$`](!0),e[`session_accountByUserPk_${t}_isLocked$`](!1),e[`session_accountByUserPk_${t}_profile$`]({npub:Ae(be(t)),meta:{events:[]}}),e[`session_accountByUserPk_${t}_relays$`]({meta:{events:[]}}),e.session_accountUserPks$([t]),e.session_workspaceKeys$([i]),e.session_openWorkspaceKeys$([i])}async function pe(t,e){let s=e.session_workspaceKeys$()||[],r=e.session_openWorkspaceKeys$()||[],i=e.session_defaultUserPk$(),c=s.length===1&&s.every(n=>e[`session_workspaceByKey_${n}_userPk$`]()===i);if(t.length===0&&c)return;let o=e.session_accountUserPks$()||[],d=t.map(n=>N(n.pubkey)),p;if(t.forEach(n=>{let l=N(n.pubkey);e[`session_accountByUserPk_${l}_isReadOnly$`](p=n.isReadOnly??!1),e[`session_accountByUserPk_${l}_isLocked$`](p?!1:n.isLocked??!0),e[`session_accountByUserPk_${l}_profile$`](n.profile),e[`session_accountByUserPk_${l}_relays$`](n.relays)}),c&&d.length===1){let n=s[0],l=d[0],m=e[`session_workspaceByKey_${n}_openAppKeys$`]()||[],u=[];m.forEach(h=>{e[`session_appByKey_${h}_visibility$`](g=>(g==="open"&&u.push(h),"closed"))}),e[`session_workspaceByKey_${n}_openAppKeys$`]([]),e[`session_workspaceByKey_${n}_userPk$`](l),await new Promise(h=>window.requestIdleCallback(()=>window.requestIdleCallback(h,{timeout:50}),{timeout:100})),u.forEach(h=>{e[`session_appByKey_${h}_visibility$`]("open")}),e[`session_workspaceByKey_${n}_openAppKeys$`](u),e.session_defaultUserPk$(void 0)}else{let n=d.filter(_=>!o.includes(_)),l=o.filter(_=>!d.includes(_));n.length>0&&i&&e.session_defaultUserPk$(void 0);let m=[];for(let _ of l)m=m.concat(s.filter(k=>e[`session_workspaceByKey_${k}_userPk$`]()===_));let u=[];for(let _ of n){let k=Pe.map(M=>({id:M,key:Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),visibility:"closed",isNew:!1})),T=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);u.push(T),e[`session_workspaceByKey_${T}_openAppKeys$`]([]),e[`session_workspaceByKey_${T}_userPk$`](_),k.forEach(M=>{e[`session_workspaceByKey_${T}_appById_${M.id}_appKeys$`]([M.key]),e[`session_appByKey_${M.key}_id$`](M.id),e[`session_appByKey_${M.key}_visibility$`](M.visibility),e[`session_appByKey_${M.key}_route$`]("")}),e[`session_workspaceByKey_${T}_unpinnedCoreAppIdsObj$`]({}),e[`session_workspaceByKey_${T}_pinnedAppIds$`](k.map(({id:M})=>M)),e[`session_workspaceByKey_${T}_unpinnedAppIds$`]([])}let h=new Set(m),g=s.filter(_=>!h.has(_)).concat(u),A=new Set(g),L=r.filter(_=>A.has(_)),K=new Set(L),S=L.concat(g.filter(_=>!K.has(_)));e.session_openWorkspaceKeys$(S),e.session_workspaceKeys$(g);for(let _ of m){let k=e[`session_workspaceByKey_${_}_pinnedAppIds$`]()||[],T=e[`session_workspaceByKey_${_}_unpinnedAppIds$`]()||[],M=[...new Set([...k,...T])];e[`session_workspaceByKey_${_}_unpinnedCoreAppIdsObj$`](void 0),e[`session_workspaceByKey_${_}_pinnedAppIds$`](void 0),e[`session_workspaceByKey_${_}_unpinnedAppIds$`](void 0),e[`session_workspaceByKey_${_}_userPk$`](void 0),e[`session_workspaceByKey_${_}_openAppKeys$`](void 0),M.forEach(q=>{(e[`session_workspaceByKey_${_}_appById_${q}_appKeys$`]()||[]).forEach(H=>{e[`session_appByKey_${H}_id$`](void 0),e[`session_appByKey_${H}_visibility$`](void 0),e[`session_appByKey_${H}_route$`](void 0)}),e[`session_workspaceByKey_${_}_appById_${q}_appKeys$`](void 0)})}}e.session_accountUserPks$(d),o.filter(n=>!d.includes(n)).forEach(n=>{e[`session_accountByUserPk_${n}_isReadOnly$`](void 0),e[`session_accountByUserPk_${n}_isLocked$`](void 0),e[`session_accountByUserPk_${n}_profile$`](void 0),e[`session_accountByUserPk_${n}_relays$`](void 0)})}var Tt=C("aModal",function(){let t=te({dialogRef$:null,render:this.props.render,shouldAlwaysDisplay$:this.props.shouldAlwaysDisplay$??this.props.shouldAlwaysDisplay??!1,isOpen$:this.props.isOpen$,close:this.props.close,afterClose:this.props.afterClose});return B(({track:e})=>{e(()=>t.isOpen$.get())?t.dialogRef$().showModal():t.dialogRef$().close()},{after:"rendering"}),this.h`
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
  `},{useShadowDOM:!1});function fe(t){return t?Ge(t):Q("<a-modal>")}function Ge(t){return Q("<a-modal>",t)}C("vaultModal",function(){let t=fe(),e=te(()=>({...t,shouldAlwaysDisplay$:!0,render:ie(function(){return this.h`<vault-messenger-wrapper />`})}));return this.h`<a-modal props=${e} />`});C("vault-messenger-wrapper",function(){let t=V(localStorage),{config_vaultUrl$:e}=t;B(()=>{e()===void 0&&e("https://44billion.github.io/44b-vault")});let s=$e(!1);B(async({track:i,cleanup:c})=>{let o=i(()=>e());if(!o){s(!1);return}s(!1);let d=0,p,n=new AbortController;c(()=>{clearTimeout(p),n.abort()});let l=async()=>{try{if(await fetch(o,{mode:"no-cors",signal:n.signal}),n.signal.aborted)return;s(!0)}catch{if(n.signal.aborted)return;d++;let u=Math.min(3e4,500*2**d);console.warn(`Vault unreachable, retrying in ${u}ms`),p=setTimeout(l,u)}};l()},{after:"rendering"});let{vaultPort$:r}=Oe({shouldInit:!0});return xe(r),!e()||!s()?this.h``:this.h`${this.h({key:e()})`<vault-messenger />`}`});function Oe({shouldInit:t=!1}={}){return t?Y("vaultMessenger",()=>({isWorkarounEnabled$:!0,disableStartAtVaultHomeWorkaroundThisTime(){this.isWorkarounEnabled$(!1)},isFirstRun$:!0,vaultPort$:null,vaultIframeRef$:null,vaultIframeSrc$:"about:blank",isVaultMessengerReady$:!1,widgetHeight$:0})):Y("vaultMessenger")}C("vault-messenger",function(){let{isFirstRun$:t,vaultPort$:e,vaultIframeRef$:s,vaultIframeSrc$:r,isVaultMessengerReady$:i,widgetHeight$:c,isWorkarounEnabled$:o}=Oe();B(({cleanup:h})=>h(()=>{e(null),r("about:blank")}));let d=V(localStorage),{config_vaultUrl$:p}=d,{cancelPreviousRequests:n,postVaultMessage:l}=xe(e),m=fe(),{isOpen$:u}=m;return B(({track:h})=>{let g=h(()=>u());t()||g||e()&&l({code:"CLOSED_VAULT_VIEW",payload:null},{instant:!0})}),B(({track:h})=>{let g=o();o(!0);let A=h(()=>!u());t()||A||!g||e()&&l({code:"OPEN_VAULT_HOME",payload:null},{instant:!0})}),B(()=>{t(!1)}),B(async({track:h,cleanup:g})=>{h(()=>p());let A=new AbortController;g(()=>{A.abort()});let L=new URL(p()).origin,K,S=()=>{K&&K.abort()},_=k=>{K=k,k&&k.signal.addEventListener("abort",()=>{K===k&&(K=null)},{once:!0})};s().addEventListener("load",()=>{setTimeout(()=>{S();let k=Ze({vaultIframe:s(),vaultPort$:e,abortSignal:A.signal});_(k)},100)},{signal:A.signal}),Xe({vaultIframe:s(),vaultOrigin:L,vaultPort$:e,componentSignal:A.signal,widgetHeight$:c,storage:d,stopRenderHandshake:S,vaultModalStore:m}),i(!0)},{after:"rendering"}),B(async({track:h})=>{let[g,A]=h(()=>[i(),p()]);g&&(r(A),n(new Error("Canceled due to new vault URL selection")))}),this.h`
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
      style=${{height:`${c()}px`}}
      id='vault'
      ref=${s}
      src=${r()}
    />
  `});function Xe({vaultIframe:t,vaultOrigin:e,vaultPort$:s,componentSignal:r,widgetHeight$:i,storage:c,stopRenderHandshake:o,vaultModalStore:d}){let p=null;r?.addEventListener("abort",()=>{p&&(p.close(),p=null)},{once:!0});let n;window.addEventListener("message",u=>{u.data.code!=="VAULT_READY"||u.source!==t.contentWindow||u.origin!==e||!u.ports[0]||(u.data.payload.accounts?pe(u.data.payload.accounts,c):console.log("Missing account data on vault startup"),n?.abort(),n=new AbortController,p&&p.close(),p=u.ports[0],l({vaultPort:p,signal:AbortSignal.any([r,n.signal])}),o?.(),m(p),s(p))},{signal:r});function l({vaultPort:u,signal:h}){u.addEventListener("message",g=>{switch(g.data.code){case"CHANGE_DIMENSIONS":{i(g.data.payload.height);break}case"CLOSE_VAULT_VIEW":{d.close();break}case"SET_ACCOUNTS_STATE":{if(!g.data.payload.accounts){console.log("Missing account data on vault message");break}pe(g.data.payload.accounts,c);break}}},{signal:h}),u.start()}function m(u){W(u,{code:"BROWSER_READY",payload:null})}}function Ze({vaultIframe:t,vaultPort$:e,abortSignal:s}){if(s?.aborted)return null;let r=new AbortController,{signal:i}=r,c,o=()=>{r.signal.aborted||r.abort()};s&&s.addEventListener("abort",o,{once:!0}),i.addEventListener("abort",()=>{c&&clearTimeout(c)},{once:!0});let d=40,p=0,n=()=>{if(i.aborted)return;let l=t?.contentWindow;if(!l){o();return}if(W(l,{code:"RENDER",payload:null},{targetOrigin:"*"}),e()){o();return}if(p>=d){o();return}p+=1;let m=Math.min(500,50*p);c=setTimeout(n,m)};return n(),r}function xe(t){return t!==void 0&&et(t),Y("useRequestVaultMessage")}function et(t){let e=V(localStorage),{config_vaultUrl$:s}=e,{msgQueue$:r}=Y("useRequestVaultMessage",()=>({vaultPort$:t,vaultOrigin$(){return new URL(s()).origin},msgQueue$:{waiting:[],running:[]},postVaultMessage(n){if(!this.vaultPort$())return Promise.reject(new Error("Vault not connected"));W(this.vaultPort$(),n)},async requestVaultMessage(n,{timeout:l,instant:m=!1}={}){if(m)return this.vaultPort$()?ue(this.vaultPort$(),n,{...l!=null&&{timeout:l}}):Promise.reject(new Error("Vault not connected"));let u=Date.now(),h=Promise.withResolvers();return h.promise.finally(()=>{this.msgQueue$(g=>(g.running=g.running.filter(A=>A.p!==h),{...g}))}),this.msgQueue$(g=>(g.waiting.push({msg:n,timeout:l,queuedAt:u,p:h}),{...g})),h.promise},cancelPreviousRequests(n){this.msgQueue$().running.forEach(l=>l.p.resolve({code:l.msg.code,payload:null,error:n||new Error("Canceled")}))}})),i=fe(),{session_openWorkspaceKeys$:c}=e,o=I(()=>{let n=c()[0];return e[`session_workspaceByKey_${n}_userPk$`]()}),d=I(()=>o()!==e.session_defaultUserPk$()||c().length>1),p=ie(n=>d()?!1:(i.open(),n.p.resolve({code:n.msg.code,payload:null,error:new Error("Not logged in")}),!0));B(({track:n})=>{let[l,m]=n(()=>[r(),t()]);if(!m)return;let u=Math.min(5-l.running.length,l.waiting.length),h=Date.now();for(let g=0;g<u;g++){let A=l.waiting.shift();if(l.running.push(A),p(A))return;let{msg:L,timeout:K,queuedAt:S,p:_}=l.running[l.running.length-u+g];ue(m,L,{...K!=null&&{timeout:S+K-h}}).then(k=>{_.resolve(k)})}})}C("nappAssetsCachingProgressBar",function(){let t;try{({cachingProgress$:t}=Q("<napp-assets-caching-progress-bar>"))}catch(o){console.warn("No cachingProgress$ store found",o);return}let e=I(()=>Object.entries(t()).filter(([o])=>!o.startsWith("_")&&(o.startsWith("/")||o.includes(".")))),s=I(()=>e().length>0),r=I(()=>{let o=e();if(o.length===0)return{overallProgress:0,fileList:"",fileCount:0};let d=o.reduce((m,[u,h])=>m+h.progress,0),p=Math.round(d/o.length),n=o.map(([m])=>{let u=m.split("/").pop()||m;return u.length>20?u.slice(0,17)+"...":u}),l=n.length>3?n.slice(0,3).join(", ")+`... (+${n.length-3} more)`:n.join(", ");return{overallProgress:p,fileList:l,fileCount:o.length}}),i=I(()=>`
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1000;
    background: linear-gradient(90deg,
      oklch(0.62 0.22 297.62 / 0.9) 0%,
      oklch(0.62 0.22 297.1 / 0.9) ${r().overallProgress}%,
      rgba(0, 0, 0, 0.7) ${r().overallProgress}%,
      rgba(0, 0, 0, 0.7) 100%
    );
    height: 4px;
    transition: all 0.3s ease;
    opacity: ${s()?1:0};
    transform: translateY(${s()?"0":"-100%"});
  `),c=I(()=>`
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
    <div style=${i()} />
    <div style=${c()}>
      Caching ${r().fileCount} asset${r().fileCount!==1?"s":""}
      (${r().overallProgress}%): ${r().fileList}
    </div>
  `});export{yt as a,Je as b,fe as c,xe as d};

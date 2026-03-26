import{b as Ae,c as ae,d as Be}from"./chunk-FZKW7XBH.js";import{c as Se,d as ye,k as Te,l as ie}from"./chunk-OZWG23JC.js";import{a as oe,e as F,f as ve,g as Ee,j as fe,l as re}from"./chunk-4YEM5IRY.js";import{a as q,b as D,f as G}from"./chunk-TBF35Z4Q.js";import{g as W,i as pe,j as ke,n as N,o as ne,p as Q,q as be,s as J,v as T}from"./chunk-EOHNSKYH.js";var he="0123456789abcdefghijklmnopqrstuvwxyz",We=BigInt(he.length),De=he[0],Fe=new Map([...he].map((t,e)=>[t,BigInt(e)]));function je(t,e=0){return Me(oe(t),e)}function Me(t,e=0){return qe(ze(t),e)}function ht(t,e=0){return je(ve(t),e)}function Ke(t){return He(Ve(t))}function Ve(t){if(typeof t!="string")throw new Error("Input must be a string.");let e=0n;for(let s of t){let n=Fe.get(s);if(n===void 0)throw new Error(`Invalid character in Base36 string: ${s}`);e=e*We+n}return e}function qe(t,e){if(typeof t!="bigint")throw new Error("Input must be a BigInt.");if(t<0n)throw new Error("Can't be signed BigInt");return t.toString(36).padStart(e,De)}function He(t){if(typeof t!="bigint")throw new Error("Input must be a BigInt.");if(t<0n)throw new Error("Can't be signed BigInt");let e=t.toString(16);return e.length%2!==0&&(e=`0${e}`),e}function ze(t){if(typeof t!="string")throw new Error("Input must be a string.");return BigInt(`0x${t}`)}function Ie(t){if(t instanceof Error)return t;let e=new Error(t.message);return e.name=t.name||"Error",e.stack=t.stack,Object.assign(e,t.context||{}),e}var xe=!1,Ye=xe?"http://":"https://",Qe=xe?"localhost:10000":"44billion.net",wt=`${Ye}${Qe}`;var X={};function Je(){return Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)}function Ge(t,e,s=5e3){if(!t||!e)throw new Error("Missing request id or code");let{promise:n,resolve:d,reject:r}=Promise.withResolvers();X[t]={resolve:d,reject:r};let a;return s!=null&&(s>0?a=setTimeout(()=>{X[t]?.reject?.(`Timeout for ${e} reqId: ${t}`)},s):X[t]?.reject?.(`Timeout for ${e} reqId: ${t}`)),n.finally(()=>{clearTimeout(a),delete X[t]})}function Xe(t){let e=X[t.data.reqId];if(!e){console.log(`Unhandled response for reqId ${t.data.reqId} (may have timed out)`,JSON.stringify(t.data));return}t.data.error?e.reject(Ie(t.data.error)):e.resolve({payload:t.data.payload,isLast:t.data.isLast??!0,ports:t.ports})}var Ze=((t,e=new WeakMap,s=new FinalizationRegistry(n=>n.abort()))=>n=>{let d=n instanceof MessagePort;if(t=d?n:globalThis,e.has(t))return;let r=new AbortController;e.set(t,r),t.addEventListener("message",async a=>{if(a.data.code==="REPLY")return Xe(a)},{signal:r.signal}),d&&t.start(),s.register(t,r)})();async function ge(t,e,s,n){if(!e.code&&!("payload"in e))throw new Error("Missing args");(!s||typeof s!="object")&&(s={targetOrigin:s,transfer:n}),Ze(t);let d=Je(),r=Ge(d,e.code,s.timeout);return t.postMessage({...e,reqId:d},s),r.then(({payload:a,ports:c})=>({code:e.code,payload:a,ports:c})).catch(a=>({code:e.code,payload:null,error:a}))}function P(t,e,s,n){if(!("payload"in e)&&!("error"in e))throw new Error("Missing args");if((!s||typeof s!="object")&&(s={targetOrigin:s,transfer:n}),s.targetOrigin??=t.origin,!s.to&&!t.source)throw new Error("Set port to options.to");s.to??=t.source,s.to.postMessage({...e,reqId:t.data.reqId,code:"REPLY"},s)}function j(t,e,s,n){if(!e.code||!("payload"in e)&&!("error"in e))throw new Error("Missing args");(!s||typeof s!="object")&&(s={targetOrigin:s,transfer:n}),t.postMessage(e,s)}async function et(t,e,s){try{let n=s.map(i=>Te(i)),d=new Blob(n,{type:e.contentType}),r=new FileReader,c=await new Promise((i,o)=>{r.onload=()=>i(r.result),r.onerror=o,r.readAsDataURL(d)}),_={fx:e.rootHash,url:c};return q(localStorage,`session_appById_${t}_icon`,_),_}catch(n){console.log("Failed to update icon storage:",n)}}async function Kt(t,e,s,n,d,r,a,c,_,i,o,{signal:f,isSingleNapp:w=!1}={}){let y=Ke(t),h=F(y)===JSON.parse(localStorage.getItem("session_defaultUserPk")),$=new URL(JSON.parse(localStorage.getItem("config_vaultUrl")));document.querySelector(`iframe[src="${$.href.replace(/\/$/,"")}"]`)||console.warn("Vault iframe not found");let R=fe(e),A=await ie.create(e,R);w&&A.updateSiteManifestMetadata({lastOpenedAsSingleNappAt:Date.now()});let K=null,g=null;f?.addEventListener("abort",()=>{K&&(K.close(),K=null),g&&(g.close(),g=null)},{once:!0});let B,x=location.origin.replace("//",`//${s}.`);window.addEventListener("message",p=>{p.data.code!=="TRUSTED_IFRAME_READY"||p.source!==d.contentWindow||p.origin!==x||(B?.abort(),B=new AbortController,K&&K.close(),K=p.ports[0],$e(K,AbortSignal.any([f,B.signal])),Z(s,n))},{signal:f});let S=!1;function Z(p,C=""){if(S)return;S=!0;let m;window.addEventListener("message",u=>{u.data.code!=="APP_IFRAME_READY"||u.source!==r.contentWindow||u.origin!==x||(m?.abort(),m=new AbortController,g&&g.close(),g=u.ports[0],Ce(g,AbortSignal.any([f,m.signal])))},{signal:f});let l=window.location.host;a(`//${p}.${l}${C}`)}function $e(p,C){p.addEventListener("message",async m=>{switch(m.data.code){case"STREAM_APP_FILE":{let l=(u,k=new Error("FILE_NOT_CACHED"))=>(u&&console.log(u),P(m,{error:k,isLast:!0},{to:p}));try{let u=await A.getFileCacheStatus(m.data.payload.pathname,null,{withMeta:!0});if(!u.isCached)if(u.isHtml)l(null,new Error("HTML_FILE_NOT_CACHED"));else{let{fileRootHash:E,total:v}=u,b=0,M=!1,U=!1,H=!1,ce=async()=>{if(!(M||U||H)){H=!0;try{for(;!M&&!U;){let L=await Se(e,E,{fromPos:b,toPos:b});if(L.length===0)break;let z=L[0];if(v===null){let te=z.evt.tags.find(se=>se[0]==="c"&&se[1].startsWith(`${E}:`)),V=parseInt(te?.[2]);!Number.isNaN(V)&&V>0&&(v=V)}let Y=v!=null&&b===v-1;P(m,{payload:{content:z.evt.content,...b===0&&{contentType:u.contentType}},isLast:Y},{to:p}),b++,Y&&(U=!0)}}catch(L){M=!0,l(L)}finally{H=!1}}},Le=async({progress:L,chunkIndex:z,total:Y,error:te})=>{if(M||U)return;if(te){M=!0;let ue=c(),{[m.data.payload.pathname]:Ne,...de}=ue;return c(de),l(te)}Y&&v===null&&(v=Y);let V=m.data.payload.pathname,se=c();c({...se,[V]:{progress:L,totalByteSizeEstimate:v?(v-1)*51e3:0}}),L>=100&&setTimeout(()=>{let ue=c(),{[V]:Ne,...de}=ue;c(de)},1e3),typeof z=="number"?z===b&&await ce():await ce()};try{if(await ce(),!U&&!M)return A.cacheFile(m.data.payload.pathname,u.pathTag,Le)}catch(L){return l(L)}}let k=0;for await(let E of ye(e,A.getFileRootHash(m.data.payload.pathname)))P(m,{payload:{content:E.evt.content,...k===0&&{contentType:u.contentType}},isLast:++k===u.total},{to:p})}catch(u){return l(u,u)}break}}},{signal:C}),p.start(),j(p,{code:"BROWSER_READY",payload:null})}let O=new Map,ee=new Map;async function le(p,C,{timeoutMs:m=1750}={}){if(O.has(p))return O.get(p);ee.has(p)||ee.set(p,{icon:!1,name:!1,promise:null});let l=ee.get(p);if(l.promise)return l.promise;C??=fe(p);let u=await ie.create(p,C),k={id:p,napp:Ae(C)},E=[];!("icon"in k)&&!l.icon&&(l.icon=!0,E.push(u.getIcon().then(b=>b&&(k.icon=b)).finally(()=>{l.icon=!1}))),!("name"in k)&&!l.name&&(l.name=!0,E.push(u.getName().then(b=>b&&(k.name=b)).finally(()=>{l.name=!1})));let v=(async()=>{if(E.length>0){let b=Promise.all(E).then(()=>O.set(p,k));await Promise.race([b,new Promise(M=>setTimeout(M,m))])}return O.set(p,k),ee.delete(p),k})();return l.promise=v,v}function Ce(p,C){p.addEventListener("message",async m=>{switch(m.data.code){case"OPEN_APP":{let l;try{let{href:u}=m.data.payload,E=new URL(u,self.location.origin).pathname,v=/^\/(\+{1,3}[a-zA-Z0-9]{48,})/,b=E.match(v);if(!b){console.error("Invalid app URL format:",u);break}let M=b[1],U=ae(M);l=re(U);let H=await le(l,U,{timeoutMs:0});await i({app:await le(e,R),name:"openApp",eKind:null,meta:{targetApp:H}}),o(u)}catch(u){let k=!1;for(let E of JSON.parse(localStorage.getItem("session_workspaceKeys"))??[])if(k=Array.isArray(JSON.parse(localStorage.getItem(`session_workspaceByKey_${E}_appById_${l}_appKeys`))),k)break;k||(q(localStorage,`session_appById_${l}_icon`,void 0),q(localStorage,`session_appById_${l}_name`,void 0),q(localStorage,`session_appById_${l}_description`,void 0),q(localStorage,`session_appById_${l}_relayHints`,void 0),await(await ie.create(l)).clearAppFiles()),console.error("Error in OPEN_APP handler:",u)}break}case"NIP07":{if(["peek_public_key","get_public_key"].includes(m.data.payload.method)&&m.data.payload.ns[0]===""&&m.data.payload.ns.length===1){P(m,{payload:y},{to:p});break}let{ns:l,method:u,params:k=[]}=m.data.payload,E=await le(e,R,{timeoutMs:0}),v;try{v=await ot(_,y,l,u,k,{isDefaultUser:h,requestPermission:i,app:E})}catch(b){v={error:b}}P(m,v,{to:p});break}case"WINDOW_NAPP":{tt(m);break}case"STREAM_APP_ICON":{try{let l=A.getFaviconMetadata();if(!l){P(m,{error:new Error("No favicon"),isLast:!0},{to:p});break}let u=await A.getFileCacheStatus(null,l.tag,{withMeta:!0});u.isCached||(await A.cacheFile(null,l.tag),u=await A.getFileCacheStatus(null,l.tag,{withMeta:!0}));let E=JSON.parse(localStorage.getItem(`session_appById_${e}_icon`))?.fx!==l.rootHash,v=[],b=0;for await(let M of ye(e,l.rootHash))E&&v.push(M.evt.content),P(m,{payload:{content:M.evt.content,...b===0&&{mimeType:l.mimeType||u.mimeType,contentType:l.contentType||u.contentType}},isLast:++b===u.total},{to:p});if(v.length>0){let{url:M}=await et(e,l,v);if(O.has(e)){let U=O.get(e);U.icon={fx:l.rootHash,url:M}}}}catch(l){console.log(l.stack),P(m,{error:l,isLast:!0},{to:p})}break}case"CACHE_APP_FILE":{try{let l=({progress:u,error:k})=>{if(k)P(m,{error:k,isLast:!0},{to:p});else{let E=u>=100;P(m,{payload:u,isLast:E},{to:p})}};A.cacheFile(m.data.payload.pathname,null,l)}catch(l){console.log(m.data.payload.pathname,"error:",l.stack),P(m,{error:l,isLast:!0},{to:p})}break}}},{signal:C}),p.start(),j(p,{code:"BROWSER_READY",payload:null})}}function tt(t){return P(t,{error:new Error("Not implemented yet")})}var st={getPublicKey:"readProfile",signEvent:"signEvent",nip04Encrypt:"encrypt",nip04Decrypt:"decrypt",nip44Encrypt:"encrypt",nip44Decrypt:"decrypt"};function nt(t){return st[t]||(()=>{throw new Error(`Unknown method ${t}`)})()}async function ot(t,e,s,n,d,{isDefaultUser:r,requestPermission:a,app:c}={}){if(r)throw new Error("Please login");if(a){let f=n.includes("_")?n.replace(/_([a-z0-9])/g,(y,h)=>h.toUpperCase()):n,w=(()=>{switch(f){case"signEvent":return d?.[0]?.kind;default:return null}})();await a({app:c,name:nt(f),eKind:w,meta:{params:d}})}let{napp:_,...i}=c,o={code:"NIP07",payload:{app:{...i,id:_},pubkey:e,ns:s,method:n,params:d}};return t(o,{timeout:12e4})}function _e(){return F(rt(),43)}function rt(){let t=crypto.getRandomValues(new Uint8Array(40)),s=2n**256n-0x14551231950b75fc4402da1732fc9bebfn;return(((a,c)=>{let _=a%c;return _>=0n?_:c+_})((a=>BigInt("0x"+(oe(a)||"0")))(t),s-1n)+1n).toString(16).padStart(64,"0")}var Re=["+32Wp7Qdz5XIbjlzHht7GdEP8IDxk6CC90ee8lRxYjx0stjsVD8yzTguF","+cA99KnC0UCyqHT5oI8fIkoza0jfB1lrvaWKmuh6h2EhTz2nw4R2a5qVNM"].map(ae).map(re);function at(){let t=D(localStorage),e=D(sessionStorage);return be("hardcoded_newAppIdsObj",{}),T(()=>{if(t.session_workspaceKeys$())return;let s=_e();t.session_defaultUserPk$(s),Pe({userPk:s,storage:t,tabStorage:e,isFirstTimeUser:!0})}),T(()=>{if(!t.session_workspaceKeys$())return;let s=t.session_workspaceKeys$()||[],n=t.session_defaultUserPk$();s.forEach(d=>{let r=t[`session_workspaceByKey_${d}_userPk$`]();r!=null&&r!==n&&!(t[`session_accountByUserPk_${r}_isReadOnly$`]()??!1)&&t[`session_accountByUserPk_${r}_isLocked$`](!0)})}),T(({track:s})=>{if(s(()=>t.session_workspaceKeys$().length>0))return;let n=_e();t.session_defaultUserPk$(n),Pe({userPk:n,storage:t,tabStorage:e,isFirstTimeUser:!0})}),t}function Pe({userPk:t,storage:e,tabStorage:s,isFirstTimeUser:n}){let d=Re.map((c,_)=>({id:c,key:Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),visibility:"closed",isNew:!1})),r=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);e.config_isSingleWindow$()===void 0&&e.config_isSingleWindow$(!1);let a=[];s[`session_workspaceByKey_${r}_openAppKeys$`](a),e[`session_workspaceByKey_${r}_userPk$`](t),d.forEach(c=>{e[`session_workspaceByKey_${r}_appById_${c.id}_appKeys$`]([c.key]),e[`session_appByKey_${c.key}_id$`](c.id),s[`session_appByKey_${c.key}_visibility$`](c.visibility),e[`session_appByKey_${c.key}_route$`]("")}),e[`session_workspaceByKey_${r}_unpinnedCoreAppIdsObj$`]({}),e[`session_workspaceByKey_${r}_pinnedAppIds$`](d.map(({id:c})=>c)),e[`session_workspaceByKey_${r}_unpinnedAppIds$`]([]),e[`session_accountByUserPk_${t}_isReadOnly$`](!0),e[`session_accountByUserPk_${t}_isLocked$`](!1),e[`session_accountByUserPk_${t}_profile$`]({npub:Be(Ee(t)),meta:{events:[]}}),e[`session_accountByUserPk_${t}_relays$`]({meta:{events:[]}}),e.session_accountUserPks$([t]),e.session_workspaceKeys$([r]),e.session_openWorkspaceKeys$([r])}async function me(t,e,s){let n=e.session_workspaceKeys$()||[],d=e.session_openWorkspaceKeys$()||[],r=e.session_defaultUserPk$(),a=n.length===1&&n.every(o=>e[`session_workspaceByKey_${o}_userPk$`]()===r);if(t.length===0&&a)return;let c=e.session_accountUserPks$()||[],_=t.map(o=>F(o.pubkey)),i;if(t.forEach(o=>{let f=F(o.pubkey);e[`session_accountByUserPk_${f}_isReadOnly$`](i=o.isReadOnly??!1),e[`session_accountByUserPk_${f}_isLocked$`](i?!1:o.isLocked??!0),e[`session_accountByUserPk_${f}_profile$`](o.profile),e[`session_accountByUserPk_${f}_relays$`](o.relays)}),a&&_.length===1){let o=n[0],f=_[0],w=s[`session_workspaceByKey_${o}_openAppKeys$`]()||[],y=[];w.forEach(h=>{s[`session_appByKey_${h}_visibility$`]($=>($==="open"&&y.push(h),"closed"))}),s[`session_workspaceByKey_${o}_openAppKeys$`]([]),e[`session_workspaceByKey_${o}_userPk$`](f),await new Promise(h=>setTimeout(h,0)),y.forEach(h=>{s[`session_appByKey_${h}_visibility$`]("open")}),s[`session_workspaceByKey_${o}_openAppKeys$`](y),e.session_defaultUserPk$(void 0)}else{let o=_.filter(g=>!c.includes(g)),f=c.filter(g=>!_.includes(g));o.length>0&&r&&e.session_defaultUserPk$(void 0);let w=[];for(let g of f)w=w.concat(n.filter(B=>e[`session_workspaceByKey_${B}_userPk$`]()===g));let y=[];for(let g of o){let B=Re.map(S=>({id:S,key:Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),visibility:"closed",isNew:!1})),x=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);y.push(x),s[`session_workspaceByKey_${x}_openAppKeys$`]([]),e[`session_workspaceByKey_${x}_userPk$`](g),B.forEach(S=>{e[`session_workspaceByKey_${x}_appById_${S.id}_appKeys$`]([S.key]),e[`session_appByKey_${S.key}_id$`](S.id),s[`session_appByKey_${S.key}_visibility$`](S.visibility),e[`session_appByKey_${S.key}_route$`]("")}),e[`session_workspaceByKey_${x}_unpinnedCoreAppIdsObj$`]({}),e[`session_workspaceByKey_${x}_pinnedAppIds$`](B.map(({id:S})=>S)),e[`session_workspaceByKey_${x}_unpinnedAppIds$`]([])}let h=new Set(w),$=n.filter(g=>!h.has(g)).concat(y),I=new Set($),R=d.filter(g=>I.has(g)),A=new Set(R),K=R.concat($.filter(g=>!A.has(g)));e.session_openWorkspaceKeys$(K),e.session_workspaceKeys$($);for(let g of w){let B=e[`session_workspaceByKey_${g}_pinnedAppIds$`]()||[],x=e[`session_workspaceByKey_${g}_unpinnedAppIds$`]()||[],S=[...new Set([...B,...x])];e[`session_workspaceByKey_${g}_unpinnedCoreAppIdsObj$`](void 0),e[`session_workspaceByKey_${g}_pinnedAppIds$`](void 0),e[`session_workspaceByKey_${g}_unpinnedAppIds$`](void 0),e[`session_workspaceByKey_${g}_userPk$`](void 0),s[`session_workspaceByKey_${g}_openAppKeys$`](void 0),S.forEach(Z=>{(e[`session_workspaceByKey_${g}_appById_${Z}_appKeys$`]()||[]).forEach(O=>{e[`session_appByKey_${O}_id$`](void 0),s[`session_appByKey_${O}_visibility$`](void 0),e[`session_appByKey_${O}_route$`](void 0)}),e[`session_workspaceByKey_${g}_appById_${Z}_appKeys$`](void 0)})}}e.session_accountUserPks$(_),c.filter(o=>!_.includes(o)).forEach(o=>{e[`session_accountByUserPk_${o}_isReadOnly$`](void 0),e[`session_accountByUserPk_${o}_isLocked$`](void 0),e[`session_accountByUserPk_${o}_profile$`](void 0),e[`session_accountByUserPk_${o}_relays$`](void 0)})}var qt=W("aModal",function(){let t=ne({dialogRef$:null,render:this.props.render,shouldAlwaysDisplay$:this.props.shouldAlwaysDisplay$??this.props.shouldAlwaysDisplay??!1,isOpen$:this.props.isOpen$,close:this.props.close,afterClose:this.props.afterClose});return T(({track:e})=>{e(()=>t.isOpen$.get())?t.dialogRef$().showModal():t.dialogRef$().close()},{after:"rendering"}),this.h`
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

              @media ${G.breakpoints.desktop} {
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

              @media ${G.breakpoints.mobile} {
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

                @media ${G.breakpoints.desktop} {
                  border-radius: 17px;
                  min-width: 400px;
                  width: 800px;
                  max-width: 90vw;
                  max-width: 90dvw;
                  max-height: 90vh; /* leave 10 for browser collapsible header */
                  max-height: 90dvh;
                }

                @media ${G.breakpoints.mobile} {
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
  `},{useShadowDOM:!1});function we(t){return t?it(t):J("<a-modal>")}function it(t){return J("<a-modal>",t)}W("vaultModal",function(){let t=we(),e=ne(()=>({...t,shouldAlwaysDisplay$:!0,render:pe(function(){return this.h`<vault-messenger-wrapper />`})}));return this.h`<a-modal props=${e} />`});W("vault-messenger-wrapper",function(){let t=D(localStorage),{config_vaultUrl$:e}=t;T(()=>{e()===void 0&&e("https://44billion.github.io/44b-vault")});let s=ke(!1);T(async({track:d,cleanup:r})=>{let a=d(()=>e());if(!a){s(!1);return}s(!1);let c=0,_,i=new AbortController;r(()=>{clearTimeout(_),i.abort()});let o=async()=>{try{if(await fetch(a,{mode:"no-cors",signal:i.signal}),i.signal.aborted)return;s(!0)}catch{if(i.signal.aborted)return;c++;let w=Math.min(3e4,500*2**c);console.warn(`Vault unreachable, retrying in ${w}ms`),_=setTimeout(o,w)}};o()},{after:"rendering"});let{vaultPort$:n}=Oe({shouldInit:!0});return Ue(n),!e()||!s()?this.h``:this.h`${this.h({key:e()})`<vault-messenger />`}`});function Oe({shouldInit:t=!1}={}){return t?Q("vaultMessenger",()=>({isWorkarounEnabled$:!0,disableStartAtVaultHomeWorkaroundThisTime(){this.isWorkarounEnabled$(!1)},isFirstRun$:!0,vaultPort$:null,vaultIframeRef$:null,vaultIframeSrc$:"about:blank",isVaultMessengerReady$:!1,widgetHeight$:0})):Q("vaultMessenger")}W("vault-messenger",function(){let{isFirstRun$:t,vaultPort$:e,vaultIframeRef$:s,vaultIframeSrc$:n,isVaultMessengerReady$:d,widgetHeight$:r,isWorkarounEnabled$:a}=Oe();T(({cleanup:h})=>h(()=>{e(null),n("about:blank")}));let c=D(localStorage),_=D(sessionStorage),{config_vaultUrl$:i}=c,{cancelPreviousRequests:o,postVaultMessage:f}=Ue(e),w=we(),{isOpen$:y}=w;return T(({track:h})=>{let $=h(()=>y());t()||$||e()&&f({code:"CLOSED_VAULT_VIEW",payload:null},{instant:!0})}),T(({track:h})=>{let $=a();a(!0);let I=h(()=>!y());t()||I||!$||e()&&f({code:"OPEN_VAULT_HOME",payload:null},{instant:!0})}),T(()=>{t(!1)}),T(async({track:h,cleanup:$})=>{h(()=>i());let I=new AbortController;$(()=>{I.abort()});let R=new URL(i()).origin,A,K=()=>{A&&A.abort()},g=B=>{A=B,B&&B.signal.addEventListener("abort",()=>{A===B&&(A=null)},{once:!0})};s().addEventListener("load",()=>{setTimeout(()=>{K();let B=ct({vaultIframe:s(),vaultPort$:e,abortSignal:I.signal});g(B)},100)},{signal:I.signal}),lt({vaultIframe:s(),vaultOrigin:R,vaultPort$:e,componentSignal:I.signal,widgetHeight$:r,storage:c,tabStorage:_,stopRenderHandshake:K,vaultModalStore:w}),d(!0)},{after:"rendering"}),T(async({track:h})=>{let[$,I]=h(()=>[d(),i()]);$&&(n(I),o(new Error("Canceled due to new vault URL selection")))}),this.h`
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
      style=${{height:`${r()}px`}}
      id='vault'
      ref=${s}
      src=${n()}
    />
  `});function lt({vaultIframe:t,vaultOrigin:e,vaultPort$:s,componentSignal:n,widgetHeight$:d,storage:r,tabStorage:a,stopRenderHandshake:c,vaultModalStore:_}){let i=null;n?.addEventListener("abort",()=>{i&&(i.close(),i=null)},{once:!0});let o;window.addEventListener("message",y=>{y.data.code!=="VAULT_READY"||y.source!==t.contentWindow||y.origin!==e||!y.ports[0]||(y.data.payload.accounts?me(y.data.payload.accounts,r,a):console.log("Missing account data on vault startup"),o?.abort(),o=new AbortController,i&&i.close(),i=y.ports[0],f({vaultPort:i,signal:AbortSignal.any([n,o.signal])}),c?.(),w(i),s(i))},{signal:n});function f({vaultPort:y,signal:h}){y.addEventListener("message",$=>{switch($.data.code){case"CHANGE_DIMENSIONS":{d($.data.payload.height);break}case"CLOSE_VAULT_VIEW":{_.close();break}case"SET_ACCOUNTS_STATE":{if(!$.data.payload.accounts){console.log("Missing account data on vault message");break}me($.data.payload.accounts,r,a);break}}},{signal:h}),y.start()}function w(y){j(y,{code:"BROWSER_READY",payload:null})}}function ct({vaultIframe:t,vaultPort$:e,abortSignal:s}){if(s?.aborted)return null;let n=new AbortController,{signal:d}=n,r,a=()=>{n.signal.aborted||n.abort()};s&&s.addEventListener("abort",a,{once:!0}),d.addEventListener("abort",()=>{r&&clearTimeout(r)},{once:!0});let c=40,_=0,i=()=>{if(d.aborted)return;let o=t?.contentWindow;if(!o){a();return}if(j(o,{code:"RENDER",payload:null},{targetOrigin:"*"}),e()){a();return}if(_>=c){a();return}_+=1;let f=Math.min(500,50*_);r=setTimeout(i,f)};return i(),n}function Ue(t){return t!==void 0&&ut(t),Q("useRequestVaultMessage")}function ut(t){let e=D(localStorage),{config_vaultUrl$:s}=e,{msgQueue$:n}=Q("useRequestVaultMessage",()=>({vaultPort$:t,vaultOrigin$(){return new URL(s()).origin},msgQueue$:{waiting:[],running:[]},postVaultMessage(i){if(!this.vaultPort$())return Promise.reject(new Error("Vault not connected"));j(this.vaultPort$(),i)},async requestVaultMessage(i,{timeout:o,instant:f=!1}={}){if(f)return this.vaultPort$()?ge(this.vaultPort$(),i,{...o!=null&&{timeout:o}}):Promise.reject(new Error("Vault not connected"));let w=Date.now(),y=Promise.withResolvers();return y.promise.finally(()=>{this.msgQueue$(h=>(h.running=h.running.filter($=>$.p!==y),{...h}))}),this.msgQueue$(h=>(h.waiting.push({msg:i,timeout:o,queuedAt:w,p:y}),{...h})),y.promise},cancelPreviousRequests(i){this.msgQueue$().running.forEach(o=>o.p.resolve({code:o.msg.code,payload:null,error:i||new Error("Canceled")}))}})),d=we(),{session_openWorkspaceKeys$:r}=e,a=N(()=>{let i=r()[0];return e[`session_workspaceByKey_${i}_userPk$`]()}),c=N(()=>a()!==e.session_defaultUserPk$()||r().length>1),_=pe(i=>c()?!1:(d.open(),i.p.resolve({code:i.msg.code,payload:null,error:new Error("Not logged in")}),!0));T(({track:i})=>{let[o,f]=i(()=>[n(),t()]);if(!f)return;let w=Math.min(5-o.running.length,o.waiting.length),y=Date.now();for(let h=0;h<w;h++){let $=o.waiting.shift();if(o.running.push($),_($))return;let{msg:I,timeout:R,queuedAt:A,p:K}=o.running[o.running.length-w+h];ge(f,I,{...R!=null&&{timeout:A+R-y}}).then(g=>{K.resolve(g)})}})}W("nappAssetsCachingProgressBar",function(){let t;try{({cachingProgress$:t}=J("<napp-assets-caching-progress-bar>"))}catch(a){console.warn("No cachingProgress$ store found",a);return}let e=N(()=>Object.entries(t()).filter(([a])=>!a.startsWith("_")&&(a.startsWith("/")||a.includes(".")))),s=N(()=>e().length>0),n=N(()=>{let a=e();if(a.length===0)return{overallProgress:0,fileList:"",fileCount:0};let c=a.reduce((f,[w,y])=>f+y.progress,0),_=Math.round(c/a.length),i=a.map(([f])=>{let w=f.split("/").pop()||f;return w.length>20?w.slice(0,17)+"...":w}),o=i.length>3?i.slice(0,3).join(", ")+`... (+${i.length-3} more)`:i.join(", ");return{overallProgress:_,fileList:o,fileCount:a.length}}),d=N(()=>`
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
  `),r=N(()=>`
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
    <div style=${d()} />
    <div style=${r()}>
      Caching ${n().fileCount} asset${n().fileCount!==1?"s":""}
      (${n().overallProgress}%): ${n().fileList}
    </div>
  `});export{ht as a,Kt as b,at as c,we as d,Ue as e};

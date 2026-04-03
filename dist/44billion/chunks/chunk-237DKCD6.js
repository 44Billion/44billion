import{b as M,k as H,l as S,m as U,o as K,q as J}from"./chunk-TQV5SO2W.js";import{g as z,l as C}from"./chunk-4YEM5IRY.js";import{a as D,b as A,e as k}from"./chunk-LLMC3MZB.js";import{g as m,j as I,l as O,m as j,n as $,o as w,u as R,v as P}from"./chunk-5XJKKVB7.js";var T=class{static _pendingSearches=new Map;static getInstalledAppIds({_localStorage:e}={}){let s=e||localStorage,o=JSON.parse(s.getItem("session_workspaceKeys")||"[]"),t=new Set;return o.forEach(a=>{let n=JSON.parse(s.getItem(`session_workspaceByKey_${a}_pinnedAppIds`)||"[]"),i=JSON.parse(s.getItem(`session_workspaceByKey_${a}_unpinnedAppIds`)||"[]");n.forEach(p=>t.add(p)),i.forEach(p=>t.add(p))}),Array.from(t)}static searchForUpdates(e,{_AppFileDownloader:s=K,_getSiteManifestFromDb:o=S,_saveSiteManifestToDb:t=U,_setWebStorageItem:a=D,_localStorage:n}={}){let i=e;(!i||i.length===0)&&(i=this.getInstalledAppIds({_localStorage:n}));let p=JSON.stringify(i.slice().sort());if(this._pendingSearches.has(p))return this._pendingSearches.get(p);let c=(async()=>{try{if(i.length===0)return{};let u=await s.getSiteManifestEvents(i),d={};for(let y of i){let h=await o(y),v=u[y];if(v){let x=v.event,l=!1;h?x.created_at>h.created_at&&(l=!0):l=!0,l&&(d[y]=v),h&&await t(h,{...h.meta,hasUpdate:l})}else h&&await t(h,{...h.meta,hasUpdate:!1})}let f=this.getInstalledAppIds({_localStorage:n}),g=0;for(let y of f)(await o(y))?.meta?.hasUpdate&&g++;return a(n||(typeof localStorage<"u"?localStorage:null),"session_unread_appUpdateCount",g),d}finally{this._pendingSearches.delete(p)}})();return this._pendingSearches.set(p,c),c}static isAppOpen(e,{_sessionStorage:s,_localStorage:o}={}){let t=s||(typeof sessionStorage<"u"?sessionStorage:null),a=o||(typeof localStorage<"u"?localStorage:null);if(!t||!a)return!1;let n=JSON.parse(a.getItem("session_workspaceKeys")||"[]");for(let i of n){let p=JSON.parse(t.getItem(`session_workspaceByKey_${i}_openAppKeys`)||"[]");if(JSON.parse(a.getItem(`session_workspaceByKey_${i}_appById_${e}_appKeys`)||"[]").some(u=>p.includes(u)))return!0}return!1}static async scheduleCleanup(e=null,{_localStorage:s,_sessionStorage:o,_getSiteManifestFromDb:t=S,_deleteStaleFileChunksFromDb:a=M,_navigator:n=typeof navigator<"u"?navigator:null,_setTimeout:i=setTimeout,ifAvailable:p=!1}={}){if(n?.locks)return n.locks.request("app-cleanup-job",{ifAvailable:p},async c=>{if(!c)return;let u=e||this.getInstalledAppIds({_localStorage:s}),d=[];for(let f of u)if(this.isAppOpen(f,{_sessionStorage:o,_localStorage:s}))d.push(f);else{let g=await t(f);if(g){let y=g.tags.filter(h=>h[0]==="path").map(h=>h[2]);await a(f,y)}}d.length>0&&i(()=>{this.scheduleCleanup(d,{_localStorage:s,_sessionStorage:o,_getSiteManifestFromDb:t,_deleteStaleFileChunksFromDb:a,_navigator:n,_setTimeout:i})},5*60*1e3)})}static initCleanupJob({_setTimeout:e=setTimeout,...s}={}){e(()=>this.scheduleCleanup(null,{...s,ifAvailable:!0}),2*60*1e3)}static async scheduleUpdateCheck({_navigator:e=typeof navigator<"u"?navigator:null,_setTimeout:s=setTimeout,ifAvailable:o=!1,interval:t=15*60*1e3,...a}={}){if(!e?.locks)return;if((e.connection||e.mozConnection||e.webkitConnection)?.metered){s(()=>this.scheduleUpdateCheck({_navigator:e,_setTimeout:s,interval:t,...a}),t);return}return e.locks.request("app-update-check-job",{ifAvailable:o},async i=>{if(i){try{await this.searchForUpdates(null,a)}catch(p){console.error("Update check failed",p)}s(()=>{this.scheduleUpdateCheck({_navigator:e,_setTimeout:s,interval:t,...a})},t)}})}static initUpdateCheckJob({_setTimeout:e=setTimeout,...s}={}){e(()=>this.scheduleUpdateCheck({...s,ifAvailable:!0}),1*60*1e3)}static async*updateApp(e,{_AppFileDownloader:s=K,_deleteStaleFileChunksFromDb:o=M,_saveSiteManifestToDb:t=U,_getSiteManifestFromDb:a=S,_addressObjToAppId:n=C,_getUserRelays:i=H,_localStorage:p,_sessionStorage:c,writeRelays:u}={}){let d=e.tags.find(l=>l[0]==="d")?.[1]??"",f=n({kind:e.kind,pubkey:e.pubkey,dTag:d});if(!u){let l=await i([e.pubkey]);u=Array.from(l[e.pubkey].write)}let g=e.tags.filter(l=>l[0]==="path").map(l=>({rootHash:l[2],filename:l[1]})),y=g.length;for(let l=0;l<y;l++){let N=g[l],E=new s(f,N.rootHash,u);try{for await(let b of E.run()){if(b.error){yield{appProgress:0,fileProgress:0,error:b.error};return}yield{appProgress:Math.floor((l*100+b.progress)/y),fileProgress:b.progress,currentFile:N.filename,error:null}}}catch(b){yield{appProgress:0,fileProgress:0,error:b};return}}let h=g.map(l=>l.rootHash);this.isAppOpen(f,{_sessionStorage:c,_localStorage:p})?await this.scheduleCleanup([f],{_localStorage:p,_sessionStorage:c,_getSiteManifestFromDb:a,_deleteStaleFileChunksFromDb:o}):await o(f,h);let x=(await a(f))?.meta?.lastOpenedAsSingleNappAt||0;await t(e,{hasUpdate:!1,lastOpenedAsSingleNappAt:x})}static async*updateApps(e,{_updateApp:s=this.updateApp,_addressObjToAppId:o=C,...t}={}){let a=e.length;for(let n=0;n<a;n++){let i=e[n],p=i.tags.find(d=>d[0]==="d")?.[1]??"",c=o({kind:i.kind,pubkey:i.pubkey,dTag:p}),u=s.call(this,i,{_addressObjToAppId:o,...t});try{for await(let d of u){let f=Math.floor((n*100+d.appProgress)/a);yield{appId:c,...d,overallProgress:f}}}catch(d){yield{appId:c,appProgress:0,fileProgress:0,error:d,overallProgress:Math.floor(n*100/a)}}}}};m("f-to-signals",function(){let r=this.props.from$??O(this.props.from),e=$(()=>(Array.isArray(r.get())?r.get().flat():Object.keys(r.get())).sort().join(":"));return this.h`${this.h({key:e.get()})`<f-to-signals-wrapped key=${e.get()} props=${{...this.props,from$:r}} />`}`});m("f-to-signals-wrapped",function(){let{render:r,...e}=this.props;return r.call(this,j(e))});var _=(()=>{let r=new WeakMap,e=0;function s(t){return r.has(t)||r.set(t,`obj:${++e}`),r.get(t)}function o(t){if(t===null)return"null";switch(typeof t){case"undefined":return"undefined";case"string":return`string:${t}`;case"number":return`number:${Number.isNaN(t)?"NaN":t}`;case"boolean":return`boolean:${t}`;case"bigint":return`bigint:${t}n`;case"symbol":return`symbol:${t.description??""}`;case"function":return s(t);case"object":return s(t);default:return`unknown:${String(t)}`}}return function(...a){try{let n=JSON.stringify(a);if(n!==void 0)return n}catch{}return a.map(o).join("|")}})();function Z(r,e=250,{getKey:s=_}={}){let o=new Map,t=new Map,a=new Map,n=Symbol("debounceDefaultKey");return function(...p){let c=s?s(...p):n;if(c==null)throw new Error("debounce: key cannot be undefined or null");let u=t.get(c);if(u)return u;let d=Date.now(),f=o.get(c);if(f!==void 0&&d-f<e)return a.get(c)??(()=>{throw new Error("debounce: no last promise found")})();o.set(c,d);let g=Promise.resolve().then(()=>r.apply(this,p)).catch(y=>{throw o.delete(c),y}).finally(()=>{t.delete(c)});return t.set(c,g),a.set(c,g),g}}async function q(r){await(await J.create(r)).getIcon()}var L=Z(q,1e3);m("appIcon",function(){let r=A(localStorage),e=$(()=>this.props.app$().id),s=$(()=>this.props.app$().index??"?"),o=$(()=>this.props.style$?.()??this.props.style??""),t=I(null),a=$(()=>!!t()),n=I(null);P(async({track:p})=>{let[,c]=p(()=>[e(),r[`session_appById_${e()}_icon$`]()]);if(!(c?.fx&&n()===c.fx)){if(n(c?.fx||null),c?.url){t(c.url);return}t(null)}});let i=I(!1);return P(async({track:p})=>{let c=p(()=>e());if(!(!c||a())){i(!0);try{await L(c)}catch(u){console.error("Failed to load app icon for appId:",c,u)}finally{Promise.resolve().then(()=>i(!1))}}}),i()?this.h`<div
      style=${`
        width: 100%;
        height: 100%;
        border-style: solid;
        border-width: 0;
        overflow: hidden;
        background-color: ${k.colors.bg2};
      `}
    >
      <style>${`
        @keyframes pulse {
          50% {
            opacity: .5;
          }
        }
        .animate-background {
          animation: pulse 2s cubic-bezier(.4,0,.6,1) infinite;
          background-color: ${k.colors.bg3};
          position: relative;
          height: 100%;
        }
      `}</style>
      <div class='animate-background' />
    </div>`:a()?this.h`
      <img
        src=${t()}
        alt="App Icon"
        style=${`
          width: 100%;
          height: 100%;
          object-fit: cover;
          ${o()}
        `}
      />
    `:this.h`
      <span style=${`
        font-weight: bold;
        font-size: 14px;
        display: flex;
        justify-content: center;
        align-items: center;
        width: 100%;
        height: 100%;
        ${o()}
      `}>${s()}</span>
    `});function B(){return Math.random().toString(36).slice(2)}var F=async function(r){try{return await X(V(r),{headers:G()})}catch(e){return console.log("Could not get avatar image",e.stack),W()}},V=function(r=B()){return`https://api.dicebear.com/9.x/avataaars/svg?${new URLSearchParams({radius:50,randomizeIds:"true",seed:r}).toString()}`},W=()=>{let r='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 280" fill="none" shape-rendering="auto"><metadata xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><rdf:RDF><rdf:Description><dc:title>Avataaars</dc:title><dc:creator>Pablo Stanley</dc:creator><dc:source xsi:type="dcterms:URI">https://avataaars.com/</dc:source><dcterms:license xsi:type="dcterms:URI">https://avataaars.com/</dcterms:license><dc:rights>Remix of \u201EAvataaars\u201D (https://avataaars.com/) by \u201EPablo Stanley\u201D, licensed under \u201EFree for personal and commercial use\u201D (https://avataaars.com/)</dc:rights></rdf:Description></rdf:RDF></metadata><mask id="an70z9ld"><rect width="280" height="280" rx="140" ry="140" x="0" y="0" fill="#fff"/></mask><g mask="url(#an70z9ld)"><g transform="translate(8)"><path d="M132 36a56 56 0 0 0-56 56v6.17A12 12 0 0 0 66 110v14a12 12 0 0 0 10.3 11.88 56.04 56.04 0 0 0 31.7 44.73v18.4h-4a72 72 0 0 0-72 72v9h200v-9a72 72 0 0 0-72-72h-4v-18.39a56.04 56.04 0 0 0 31.7-44.73A12 12 0 0 0 198 124v-14a12 12 0 0 0-10-11.83V92a56 56 0 0 0-56-56Z" fill="#d08b5b"/><path d="M108 180.61v8a55.79 55.79 0 0 0 24 5.39c8.59 0 16.73-1.93 24-5.39v-8a55.79 55.79 0 0 1-24 5.39 55.79 55.79 0 0 1-24-5.39Z" fill="#000" fill-opacity=".1"/><g transform="translate(0 170)"><path d="M132.5 65.83c27.34 0 49.5-13.2 49.5-29.48 0-1.37-.16-2.7-.46-4.02A72.03 72.03 0 0 1 232 101.05V110H32v-8.95A72.03 72.03 0 0 1 83.53 32a18 18 0 0 0-.53 4.35c0 16.28 22.16 29.48 49.5 29.48Z" fill="#ffffff"/></g><g transform="translate(78 134)"><path d="M40 16c0 5.37 6.16 9 14 9s14-3.63 14-9c0-1.1-.95-2-2-2-1.3 0-1.87.9-2 2-1.24 2.94-4.32 4.72-10 5-5.68-.28-8.76-2.06-10-5-.13-1.1-.7-2-2-2-1.05 0-2 .9-2 2Z" fill="#000" fill-opacity=".6"/></g><g transform="translate(104 122)"><path fill-rule="evenodd" clip-rule="evenodd" d="M16 8c0 4.42 5.37 8 12 8s12-3.58 12-8" fill="#000" fill-opacity=".16"/></g><g transform="translate(76 90)"><path d="M27 16c-4.84 0-9 2.65-10.84 6.45-.54 1.1.39 1.85 1.28 1.12a15.13 15.13 0 0 1 9.8-3.22 6 6 0 1 0 10.7 2.8 2 2 0 0 0-.12-.74l-.15-.38a6 6 0 0 0-1.64-2.48C33.9 17.32 30.5 16 27 16ZM85 16c-4.84 0-9 2.65-10.84 6.45-.54 1.1.39 1.85 1.28 1.12a15.13 15.13 0 0 1 9.8-3.22 6 6 0 1 0 10.7 2.8 2 2 0 0 0-.12-.74l-.15-.38a6 6 0 0 0-1.64-2.48C91.9 17.32 88.5 16 85 16Z" fill="#000" fill-opacity=".6"/></g><g transform="translate(76 82)"><path d="M38.03 5.6c-1.48 8.38-14.1 14.17-23.24 10.42a2.04 2.04 0 0 0-2.64 1c-.43.97.04 2.1 1.05 2.5 11.45 4.7 26.84-2.37 28.76-13.3a1.92 1.92 0 0 0-1.64-2.2 2 2 0 0 0-2.3 1.57ZM73.97 5.6c1.48 8.38 14.1 14.17 23.24 10.42 1.02-.41 2.2.03 2.63 1 .43.97-.04 2.1-1.05 2.5-11.44 4.7-26.84-2.37-28.76-13.3a1.92 1.92 0 0 1 1.64-2.2 2 2 0 0 1 2.3 1.57Z" fill="#000" fill-opacity=".6"/></g><g transform="translate(-1)"><path fill-rule="evenodd" clip-rule="evenodd" d="M76 98c.35 1.49 1.67 1.22 2 0-.46-1.55 3.3-28.75 13-36 3.62-2.52 23-4.77 42.31-4.75 19.1 0 38.11 2.26 41.69 4.75 9.7 7.25 13.46 34.45 13 36 .33 1.22 1.65 1.49 2 0 .72-10.3 0-63.73-57-63-57 .73-57.72 52.7-57 63Z" fill="#2c1b18"/></g><g transform="translate(49 72)"/><g transform="translate(62 42)"/></g></g></svg>',e=r.match(/mask id="([^"]*)"/);return r.replaceAll(e,B())},X=async(r,e,s=5e3)=>{let o=new AbortController,t=fetch(r,e),a=new Promise(p=>setTimeout(p,s)),n=await Promise.race([t,a]);if(!n)throw o.abort(),new Error("API took too long to respond");let i=await n.text();if(!n.ok)throw new Error(i);return i},G=()=>{let r=new Headers;return r.append("Accept","image/svg+xml"),r};m("iconUserCircle",function(){let r=w({path$:["M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0","M12 10m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0","M6.168 18.849a4 4 0 0 1 3.832 -2.849h4a4 4 0 0 1 3.834 2.855"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...r,...this.props}}
  />`});m("aAvatar",function(){let r=A(localStorage),{props:e}=this,s=w({usePlaceholder$:e.usePlaceholder$??e.usePlaceholder??!1,pk$:e.pk$??e.pk,picture$(){let o=e.picture$?.()??e.picture??r[`session_accountByUserPk_${this.pk$()}_profile$`]()?.picture;if(!o)return null;let t=/^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*(?:;base64)?,/i.test(o),a=/^(https?:\/\/)[^\s?#]+\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)(?:[?#].*)?$/i.test(o),n=/^(?:\.{0,2}\/)?[^\s?#]+\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)(?:[?#].*)?$/i.test(o);return t||a||!n?o:null},svg$:R(()=>{let o=s.pk$();if(o)return F(z(o))})});return s.picture$()?this.h`<img
      src=${s.picture$()}
      alt='User avatar'
      style=${`
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: 50%;
        background-color: ${k.colors.bgAvatar};
      `}
    />`:!s.pk$()||!s.svg$()?s.usePlaceholder$()?this.h`<div
          style=${`
            width: 100%;
            height: 100%;
            border-style: solid;
            border-width: 0;
            overflow: hidden;
          `}
        >
          <style>${`
              @keyframes pulse {
                50% {
                  opacity: .5;
                }
              }
            .animate-background {
              animation: pulse 2s cubic-bezier(.4,0,.6,1) infinite;
              background-color: ${k.colors.bgAvatarLoading};
              position: relative;
              height: 100%;
            }
          `}</style>
          <div class='animate-background' />
        </div>`:this.h`<icon-user-circle props=${this.props} />`:this.h`<a-svg props=${{...this.props,svg:s.svg$()}} />`});m("iconReload",function(){let r=w({path$:["M19.933 13.041a8 8 0 1 1 -9.925 -8.788c3.899 -1 7.935 1.007 9.425 4.747","M20 4v5h-5"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...r,...this.props}}
  />`});m("iconExclamationMark",function(){let r=w({path$:["M12 19v.01","M12 15v-10"],viewBox$:"2 2 20 20",weight$:"bold"});return this.h`<a-svg
    props=${{...r,...this.props}}
  />`});export{T as a};

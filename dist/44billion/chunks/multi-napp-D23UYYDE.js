import{a as x,b as L,c as j,d as ie,e as re,f as N,g as U,h as g,i as O,j as T,k as Z}from"./chunk-GEY5U4WT.js";import{A as M,B as X,E as D,H as se,J as te,L as oe,h as u,j as R,k as B,m as E,n as G,o as w,p as y,q as A,r as q,s as Y,t as P,u as J,v as ee,w as K}from"./chunk-3BAMIFL4.js";function he(e){let{onPopState:t}=A("_f_useLocation",{url$:()=>new URL(window.location),state$(){return this.url$()&&history.state},params$(){return e?.find?.(this.url$().pathname.replace(/\/+$/,""))?.params??{}},replaceState(...o){history.replaceState(...o),o[2]&&location.href!==this.url$().href&&this.url$(new URL(window.location))},pushState(...o){if(!o[2]||location.href===this.url$().href)throw new Error("Use replaceState when keeping url");history.pushState(...o),this.url$(new URL(window.location))},onPopState(){this.url$(new URL(window.location))}});fe(t)}function z(e){return e&&he(e),A("_f_useLocation")}function fe(e){K(({cleanup:t})=>{let o=new AbortController;t(()=>o.abort()),window.addEventListener("popstate",e,{signal:o.signal})})}var me=/^[^/]+/,$e=/^(:\w|\()/,ge=/:\w|\(/,ye=/^(?::(\w+))?(?:\(([^)]+)\))?/,F=class{constructor(t){this.root=this.createNode(),t&&Object.entries(t).forEach(o=>this.add(...o))}createNode({regex:t,param:o,handler:i}={}){return{regex:t,param:o,handler:i,children:{string:{},regex:{}}}}add(t,o){return this.parseOptim(t,o,this.root),this}parseOptim(t,o,i){if(ge.test(t))this.parse(t,o,i);else{let s=i.children.string[t];s?s.handler=o:i.children.string[t]=this.createNode({handler:o})}}parse(t,o,i){if($e.test(t)){let s=t.match(ye);if(s){let r=i.children.regex[s[0]];r||(r=i.children.regex[s[0]]=this.createNode({regex:s[2]?new RegExp("^"+s[2]):me,param:s[1]})),s[0].length===t.length?r.handler=o:this.parseOptim(t.slice(s[0].length),o,r)}}else{let s=t[0],r=i.children.string[s];r||(r=i.children.string[s]=this.createNode()),this.parse(t.slice(1),o,r)}}find(t){return this.findOptim(t,this.root,{})}findOptim(t,o,i){let s=o.children.string[t];return s&&s.handler!==void 0?{handler:s.handler,params:i}:this.findRecursive(t,o,i)}findRecursive(t,o,i){let s=o.children.string[t[0]];if(s){let r=this.findRecursive(t.slice(1),s,i);if(r)return r}for(let r in o.children.regex)if(s=o.children.regex[r],s.regex){let n=t.match(s.regex);if(n){if(n[0].length===t.length&&s.handler!==void 0)return s.param&&(i[s.param]=decodeURIComponent(n[0])),{handler:s.handler,params:i};{let a=this.findOptim(t.slice(n[0].length),s,i);if(a)return s.param&&(i[s.param]=decodeURIComponent(n[0])),a}}}return null}},ne=F;var we=new ne({"/:napp(\\+{1,3}\\w+):appPath($|\\/.*)":{}}),W=we;function H(){return Y("useScrollbarConfig",()=>{let e=document.createElement("div");e.style.cssText=`
      position: absolute;
      top: -9999px;
      width: 100px;
      height: 100px;
      overflow: scroll;
      visibility: hidden;
    `,document.body.appendChild(e);let t=e.offsetWidth-e.clientWidth;document.body.removeChild(e);let o=t>0;return{width:t,hasClassic:o,hasOverlay:!o,className:o?"classic-scrollbar":"overlay-scrollbar"}})}u("pointerupInterceptor",function(){let{props:{isOpen$:e,isOpenedByLongPress:t}}=this;if(!t)return;let o=y(()=>({isFirstRun$:!0,dialogRef$:null,shouldOpen$(){let i=e();return this.isFirstRun$.get(!1)?(this.isFirstRun$.set(!1),!1):i},onPointerUp(){requestIdleCallback(()=>this.dialogRef$().hidePopover(),{timeout:150})}}));return K(({track:i})=>{i(()=>o.shouldOpen$())&&o.dialogRef$().showPopover()},{after:"rendering"}),this.h`<div
    popover
    ref=${o.dialogRef$}
    onpointerup=${o.onPointerUp}
    style=${`
      background-color: transparent;
      border: none;
      padding: 0;
      margin: 0;
      width: 100%;
      height: 100%;
    `}
  />`});u("aMenu",function(){let e=y({id$:this.props.id$||this.props.id||"a"+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),dialogRef$:null,render:this.props.render,shouldAlwaysDisplay$:this.props.shouldAlwaysDisplay$??this.props.shouldAlwaysDisplay??!1,isOpen$:this.props.isOpen$,close:this.props.close,afterClose:this.props.afterClose,style$:this.props.style$??this.props.style??"",anchorRef$:this.props.anchorRef$,fallbackPositioningStyle$:""}),t=y(()=>({isOpen$:e.isOpen$,isOpenedByLongPress:this.props.isOpenedByLongPress??!1}));return K(({track:o})=>{let i=o(()=>e.isOpen$.get()),s=o(()=>e.anchorRef$());!i||!s||CSS.supports("position-anchor","--test")||(e.fallbackPositioningStyle$(`
      & {
        visibility: hidden;
      }
    `),setTimeout(()=>{requestAnimationFrame(()=>{let r=s.getBoundingClientRect(),n=e.dialogRef$().getBoundingClientRect(),a=window.innerWidth>window.innerHeight,p=6,l,d;if(a)l=Math.max(p,r.left-n.width-p),d=r.top;else{l=r.left;let $=n.height>0?n.height:100;d=Math.max(p,r.top-$-p)}e.fallbackPositioningStyle$(`
          & {
            left: ${l}px;
            top: ${d}px;
            right: auto;
            bottom: auto;
          }
        `)})},50))},{after:"rendering"}),K(({track:o})=>{o(()=>e.isOpen$.get())?e.dialogRef$().showPopover():e.dialogRef$().hidePopover()},{after:"rendering"}),this.h`
    <dialog
      id=${e.id$()}
      ref=${e.dialogRef$}
      data-name='menu'
      popover
      ontoggle=${o=>{o.newState!=="closed"||!e.isOpen$()||e.close()}}
      class="scope_f8d73h"
    >
      <style>${`
        .scope_f8d73h {
          & {
            container-type: normal;
            --duration: .3s;
            /* display: none; (default) */
            transition:
              overlay var(--duration) ease-in-out allow-discrete,
              display var(--duration) ease-in-out allow-discrete;
            position-area: top center;
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

          &:popover-open, /* &[open] */ /* after dialog.showPopover() */ {
          }

          &:popover-open::backdrop /* &[open]::backdrop */ {
            backdrop-filter: blur(1px);

            @starting-style {
              backdrop-filter: blur(0px);
            }
          }

          &::backdrop {
            /* display: none; (default) */
            backdrop-filter: blur(0px);
            transition:
              backdrop-filter var(--duration) ease-in-out,
              overlay var(--duration) ease-in-out allow-discrete;
          }

          &#${e.id$()} {
            ${e.fallbackPositioningStyle$()}
            ${e.style$()}
          }
        }
      `}</style>
      ${(e.shouldAlwaysDisplay$.get()||e.isOpen$.get()||"")&&(e.render?.call(this)??"")}
      <pointerup-interceptor props=${t} />
    </dialog>
  `});function Q(){return Math.random().toString(36).slice(2)}var ae=async function(e){try{return await ke(be(e),{headers:xe()})}catch(t){return console.log("Could not get avatar image",t.stack),ve()}},be=function(e=Q()){return`https://api.dicebear.com/9.x/avataaars/svg?${new URLSearchParams({radius:50,randomizeIds:"true",seed:e}).toString()}`},ve=()=>{let e='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 280" fill="none" shape-rendering="auto"><metadata xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><rdf:RDF><rdf:Description><dc:title>Avataaars</dc:title><dc:creator>Pablo Stanley</dc:creator><dc:source xsi:type="dcterms:URI">https://avataaars.com/</dc:source><dcterms:license xsi:type="dcterms:URI">https://avataaars.com/</dcterms:license><dc:rights>Remix of \u201EAvataaars\u201D (https://avataaars.com/) by \u201EPablo Stanley\u201D, licensed under \u201EFree for personal and commercial use\u201D (https://avataaars.com/)</dc:rights></rdf:Description></rdf:RDF></metadata><mask id="an70z9ld"><rect width="280" height="280" rx="140" ry="140" x="0" y="0" fill="#fff"/></mask><g mask="url(#an70z9ld)"><g transform="translate(8)"><path d="M132 36a56 56 0 0 0-56 56v6.17A12 12 0 0 0 66 110v14a12 12 0 0 0 10.3 11.88 56.04 56.04 0 0 0 31.7 44.73v18.4h-4a72 72 0 0 0-72 72v9h200v-9a72 72 0 0 0-72-72h-4v-18.39a56.04 56.04 0 0 0 31.7-44.73A12 12 0 0 0 198 124v-14a12 12 0 0 0-10-11.83V92a56 56 0 0 0-56-56Z" fill="#d08b5b"/><path d="M108 180.61v8a55.79 55.79 0 0 0 24 5.39c8.59 0 16.73-1.93 24-5.39v-8a55.79 55.79 0 0 1-24 5.39 55.79 55.79 0 0 1-24-5.39Z" fill="#000" fill-opacity=".1"/><g transform="translate(0 170)"><path d="M132.5 65.83c27.34 0 49.5-13.2 49.5-29.48 0-1.37-.16-2.7-.46-4.02A72.03 72.03 0 0 1 232 101.05V110H32v-8.95A72.03 72.03 0 0 1 83.53 32a18 18 0 0 0-.53 4.35c0 16.28 22.16 29.48 49.5 29.48Z" fill="#ffffff"/></g><g transform="translate(78 134)"><path d="M40 16c0 5.37 6.16 9 14 9s14-3.63 14-9c0-1.1-.95-2-2-2-1.3 0-1.87.9-2 2-1.24 2.94-4.32 4.72-10 5-5.68-.28-8.76-2.06-10-5-.13-1.1-.7-2-2-2-1.05 0-2 .9-2 2Z" fill="#000" fill-opacity=".6"/></g><g transform="translate(104 122)"><path fill-rule="evenodd" clip-rule="evenodd" d="M16 8c0 4.42 5.37 8 12 8s12-3.58 12-8" fill="#000" fill-opacity=".16"/></g><g transform="translate(76 90)"><path d="M27 16c-4.84 0-9 2.65-10.84 6.45-.54 1.1.39 1.85 1.28 1.12a15.13 15.13 0 0 1 9.8-3.22 6 6 0 1 0 10.7 2.8 2 2 0 0 0-.12-.74l-.15-.38a6 6 0 0 0-1.64-2.48C33.9 17.32 30.5 16 27 16ZM85 16c-4.84 0-9 2.65-10.84 6.45-.54 1.1.39 1.85 1.28 1.12a15.13 15.13 0 0 1 9.8-3.22 6 6 0 1 0 10.7 2.8 2 2 0 0 0-.12-.74l-.15-.38a6 6 0 0 0-1.64-2.48C91.9 17.32 88.5 16 85 16Z" fill="#000" fill-opacity=".6"/></g><g transform="translate(76 82)"><path d="M38.03 5.6c-1.48 8.38-14.1 14.17-23.24 10.42a2.04 2.04 0 0 0-2.64 1c-.43.97.04 2.1 1.05 2.5 11.45 4.7 26.84-2.37 28.76-13.3a1.92 1.92 0 0 0-1.64-2.2 2 2 0 0 0-2.3 1.57ZM73.97 5.6c1.48 8.38 14.1 14.17 23.24 10.42 1.02-.41 2.2.03 2.63 1 .43.97-.04 2.1-1.05 2.5-11.44 4.7-26.84-2.37-28.76-13.3a1.92 1.92 0 0 1 1.64-2.2 2 2 0 0 1 2.3 1.57Z" fill="#000" fill-opacity=".6"/></g><g transform="translate(-1)"><path fill-rule="evenodd" clip-rule="evenodd" d="M76 98c.35 1.49 1.67 1.22 2 0-.46-1.55 3.3-28.75 13-36 3.62-2.52 23-4.77 42.31-4.75 19.1 0 38.11 2.26 41.69 4.75 9.7 7.25 13.46 34.45 13 36 .33 1.22 1.65 1.49 2 0 .72-10.3 0-63.73-57-63-57 .73-57.72 52.7-57 63Z" fill="#2c1b18"/></g><g transform="translate(49 72)"/><g transform="translate(62 42)"/></g></g></svg>',t=e.match(/mask id="([^"]*)"/);return e.replaceAll(t,Q())},ke=async(e,t,o=5e3)=>{let i=new AbortController,s=fetch(e,t),r=new Promise(p=>setTimeout(p,o)),n=await Promise.race([s,r]);if(!n)throw i.abort(),new Error("API took too long to respond");let a=await n.text();if(!n.ok)throw new Error(a);return a},xe=()=>{let e=new Headers;return e.append("Accept","image/svg+xml"),e};var _e="M0 0h24v24H0V0zm2 2v20h20V2H2z";u("aSvg",function(){let e=y(()=>{let t=this;return{scopeId$:"scope_"+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),style$:this.props.style$||this.props.style||"",path$:this.props.path$||this.props.paths$||this.props.path||this.props.paths,_viewBox$:this.props.viewBox$||this.props.viewbox$||this.props.viewBox||this.props.viewbox,viewBox$(){return this._viewBox$()||"0 0 24 24"},hadInitialSvg:!!(this.props.svg$||this.props.svg),shouldKeepDefaultPathStyle$:this.props.shouldKeepDefaultPathStyle$||this.props.shouldKeepDefaultPathStyle||!!(t.props.svg$||t.props.svg),class$:this.props.class$||this.props.class||"",_svgStrings$:[],_svg$(){let o=t.props.svg$?.()||t.props.svg;return typeof o!="string"?o:(this._svgStrings$().length=0,this._svgStrings$().push(o),t.s(this._svgStrings$()))},svg$(){return this._svg$()?this._svg$():t.s`<svg
          class=${this.class$.get()}
          xmlns="http://www.w3.org/2000/svg"
          viewBox=${this.viewBox$.get()}
        >
          ${(Array.isArray(this.path$.get())?this.path$.get():[this.path$.get()||_e]).map((o,i)=>t.s({key:i})`<path key=${i} d=${o} />`)}
        </svg>`},color$:this.props.color$||this.props.color||"currentcolor",size$:this.props.size$||this.props.size||"1em",_width$:this.props.width$||this.props.width,_height$:this.props.height$||this.props.height,width$:function(){return this._width$.get()??this.size$.get()},height$:function(){return this._height$.get()??this.size$.get()},weight$:this.props.weight$||this.props.weight||["thin","light","regular","bold","fill","duotone"][1],corner$:this.props.corner$||this.props.corner||["rounded","sharp"][0],mirrored$:(this.props.mirrored$||this.props.mirrored)??!1,flip$:this.props.flip$||this.props.flip||null,scale$:function(){let o;if(this.mirrored$.get()?o="horizontal":o=this.flip$.get(),!o)return"scale(1)";let i=["both","horizontal"].includes(o)?"-1":"1",s=["both","vertical"].includes(o)?"-1":"1";return`scale(${i}, ${s})`},_rotate$:this.props.rotate$||this.props.rotate||"0",rotate$:function(){return`rotate(${this._rotate$.get()})`},_strokeWidth$:this.props.strokeWidth$||this.props.strokeWidth,strokeWidth$:function(){return this._strokeWidth$()??({thin:1,light:1.5,regular:2,bold:3,fill:2,duotone:2}[this.weight$.get()]||0)},fill$:this.props.fill$||this.props.fill||function(){return["fill","duotone"].includes(this.weight$.get())?"currentcolor":"none"},fillOpacity$:this.props.fillOpacity$||this.props.fillOpacity||function(){return this.weight$.get()==="duotone"?".2":"unset"}}});if(K(({track:t})=>{t(()=>[e.svg$.get(),e._viewBox$.get()]),e.hadInitialSvg&&e._viewBox$.get()&&this.getElementsByTagName("svg")[0].setAttribute("viewBox",e._viewBox$.get())},{after:"rendering"}),!!e.svg$.get())return this.h`<div id=${e.scopeId$()}>${this.s`
    <style>${`
      /* @scope { */
      #${e.scopeId$()} { display: contents;
        svg {
          /*
            Aligns at middle when no size is set (default 1em)
            if instead parent had set e.g. font-size: 36px;
            You may set it to vertical-align: middle; or other
            value using props.style$
          */
          vertical-align: bottom;
          pointer-events: bounding-box; /* clickable inside holes */
          stroke-width: ${e.strokeWidth$.get()}; /* add unit or it will depend on bbox's unit */
          color: ${e.color$.get()==="currentColor"?"currentcolor":e.color$.get()};
          transform: ${e.scale$.get()}
                     ${e.rotate$.get()};
          width: ${e.width$()};
          height: ${e.height$()};
        }
        ${e.shouldKeepDefaultPathStyle$()?"":`path {
          fill: ${e.fill$.get()};
          fill-opacity: ${e.fillOpacity$.get()};
          stroke: currentcolor;
          ${e.corner$.get()==="sharp"?"":`
            stroke-linecap: round;
            stroke-linejoin: round;
          `}
        }`}
        ${e.style$.get()}
      }
    `}</style>${e.svg$.get()}
  `}</div>`});u("iconUserCircle",function(){let e=y({path$:["M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0","M12 10m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0","M6.168 18.849a4 4 0 0 1 3.832 -2.849h4a4 4 0 0 1 3.834 2.855"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...e,...this.props}}
  />`});u("aAvatar",function(){let e=x(localStorage),t=y({pk$:this.props.pk$??this.props.pk,picture$(){let o=e[`session_accountByUserPk_${this.pk$()}_profile$`]()?.picture;if(!o)return null;let i=/^data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*(?:;base64)?,/i.test(o),s=/^(https?:\/\/)[^\s?#]+\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)(?:[?#].*)?$/i.test(o),r=/^(?:\.{0,2}\/)?[^\s?#]+\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)(?:[?#].*)?$/i.test(o);return i||s||!r?o:null},svg$:ee(()=>{let o=t.pk$();if(o)return ae(M(o))})});return t.picture$()?this.h`<img
      src=${t.picture$()}
      alt='User avatar'
      style=${`
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: 50%;
        background-color: ${g.colors.header};
      `}
    />`:!t.pk$()||!t.svg$()?this.h`<icon-user-circle props=${this.props} />`:this.h`<a-svg props=${{...this.props,svg:t.svg$()}} />`});var pe="data:image/webp;base64,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";function le(e){try{let t=new URL(e),{protocol:o,hostname:i,pathname:s}=t;return!(o!=="wss:"||i==="localhost"||i.endsWith(".local")||i==="[::1]"||/^(127\.|10\.|192\.168\.)/.test(i)||!i.includes(".")&&!i.startsWith("[")||i.endsWith(".onion")||e.includes("npub1")||e.includes("nprofile")||s.includes("://"))}catch{return!1}}function V(){let e=z(),t=x(localStorage),{session_openWorkspaceKeys$:o}=t,i=R((r,n)=>{let a=o()[0];if(!a)throw new Error("User n/a");let{[`session_workspaceByKey_${a}_appById_${r}_appKeys$`]:p,[`session_workspaceByKey_${a}_pinnedAppIds$`]:l,[`session_workspaceByKey_${a}_unpinnedAppIds$`]:d}=t;if(!p()||!l().includes(r)&&!d().includes(r))return{hasOpened:!1,isInstalled:!1};function $(m){return{closed:3,minimized:2,open:1}[m]}let c=p().map(m=>({key:m,wsKey:a,vis:t[`session_appByKey_${m}_visibility$`]()})).sort((m,f)=>$(f.vis)-$(m.vis))[0];if(!c)throw new Error("App install error");switch(c.vis){case"closed":{t[`session_appByKey_${c.key}_visibility$`]("open"),t[`session_workspaceByKey_${c.wsKey}_openAppKeys$`]((m,f)=>{let _=m.indexOf(c.key);return _!==-1&&m.splice(_,1),m.unshift(c.key),m[f]=Math.random(),m}),t[`session_appByKey_${c.key}_route$`](n);break}case"minimized":{let m=c.key;t[`session_appByKey_${m}_visibility$`]("open"),t[`session_workspaceByKey_${c.wsKey}_openAppKeys$`]((f,_)=>{let h=f.indexOf(m);return h!==-1&&f.splice(h,1),f.unshift(m),f[_]=Math.random(),f}),t[`session_appByKey_${c.key}_route$`](n);break}case"open":return{hasOpened:!1,isInstalled:!0}}return{hasOpened:!0,isInstalled:!0}}),s=R((r,n)=>{if(!o().length)throw new Error;let a=oe(r),p=se(a),l=a.relays.slice(0,4).map(f=>f.trim().replace(/\/+$/,"")).filter(le).slice(0,2);l.length>0&&t[`session_appById_${p}_relayHints$`](l);let{hasOpened:d,isInstalled:$}=i(p,n);if(d)return;let c={id:p,key:Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2),visibility:"open",route:n,isNew:!1},m=o()[0];t[`session_workspaceByKey_${m}_appById_${c.id}_appKeys$`](f=>($||(f=[]),f.push(c.key),f)),t[`session_appByKey_${c.key}_id$`](c.id),t[`session_appByKey_${c.key}_route$`](n),t[`session_appByKey_${c.key}_visibility$`](c.visibility),t[`session_workspaceByKey_${m}_openAppKeys$`]((f,_)=>{let h=f.indexOf(c.key);return h!==-1&&f.splice(h,1),f.unshift(c.key),f[_]=Math.random(),f}),!$&&t[`session_workspaceByKey_${m}_unpinnedAppIds$`](f=>(f.unshift(c.id),f))});K(({track:r})=>{if(!te.test(r(()=>e.url$().pathname.split("/")[1])))return;let n,{napp:a,appPath:p}=e.params$();p=p.replace(/^\/{0,}/,"/");let{search:l,hash:d}=e.url$();p!=="/"||l||d?n=p+l+d:n="";try{s(a,n)}catch($){console.log($)}finally{e.replaceState(history.state,"","/")}}),A("useAppRouter",()=>({openApp(r){let n=new URL(r,window.location.origin),a,{napp:p,appPath:l}=W.find(n.pathname.replace(/\/+$/,"")).params;l=l.replace(/^\/{0,}/,"/");let{search:d,hash:$}=n;l!=="/"||d||$?a=l+d+$:a="",s(p,a)}}))}var Se=(()=>{let e=new WeakMap,t=0;function o(s){return e.has(s)||e.set(s,`obj:${++t}`),e.get(s)}function i(s){if(s===null)return"null";switch(typeof s){case"undefined":return"undefined";case"string":return`string:${s}`;case"number":return`number:${Number.isNaN(s)?"NaN":s}`;case"boolean":return`boolean:${s}`;case"bigint":return`bigint:${s}n`;case"symbol":return`symbol:${s.description??""}`;case"function":return o(s);case"object":return o(s);default:return`unknown:${String(s)}`}}return function(...r){try{let n=JSON.stringify(r);if(n!==void 0)return n}catch{}return r.map(i).join("|")}})();function ce(e,t=250,{getKey:o=Se}={}){let i=new Map,s=new Map,r=new Map,n=Symbol("debounceDefaultKey");return function(...p){let l=o?o(...p):n;if(l==null)throw new Error("debounce: key cannot be undefined or null");let d=s.get(l);if(d)return d;let $=Date.now(),c=i.get(l);if(c!==void 0&&$-c<t)return r.get(l)??(()=>{throw new Error("debounce: no last promise found")})();i.set(l,$);let m=Promise.resolve().then(()=>e.apply(this,p)).catch(f=>{throw i.delete(l),f}).finally(()=>{s.delete(l)});return s.set(l,m),r.set(l,m),m}}async function Be(e){await(await j.create(e)).getIcon()}var Ae=ce(Be,1e3);u("appIcon",function(){let e=x(localStorage),t=w(()=>this.props.app$().id),o=w(()=>this.props.app$().index??"?"),i=w(()=>this.props.style$?.()??this.props.style??""),s=B(null),r=w(()=>!!s()),n=B(null);K(async({track:p})=>{let[,l]=p(()=>[t(),e[`session_appById_${t()}_icon$`]()]);if(!(l?.fx&&n()===l.fx)){if(n(l?.fx||null),l?.url){s(l.url);return}s(null)}});let a=B(!1);return K(async({track:p})=>{let l=p(()=>t());if(!(!l||r())){a(!0);try{await Ae(l)}catch(d){console.error("Failed to load app icon for appId:",l,d)}finally{requestIdleCallback(()=>a(!1),{timeout:150})}}}),a()?this.h`<div
      style=${`
        width: 100%;
        height: 100%;
        border-style: solid;
        border-width: 0;
        overflow: hidden;
        border-radius: 10px;
        background-color: ${g.colors.mg};
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
          background-color: ${g.colors.fg};
          position: relative;
          height: 100%;
        }
      `}</style>
      <div class='animate-background' />
    </div>`:r()?this.h`
      <img
        src=${s()}
        alt="App Icon"
        style=${`
          width: 100%;
          height: 100%;
          object-fit: cover;
          border-radius: 10px;
          background-color: ${g.colors.header};
          ${i()}
        `}
      />
    `:this.h`
      <span style=${`
        border-radius: 10px;
        background-color: ${g.colors.header};
        color: ${g.colors.fgFont};
        font-weight: bold;
        font-size: 14px;
        display: flex;
        justify-content: center;
        align-items: center;
        width: 100%;
        height: 100%;
        ${i()}
      `}>${o()}</span>
    `});u("iconClose",function(){let e=y({path$:["M18 6l-12 12","M6 6l12 12"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...e,...this.props}}
  />`});u("iconMinimize",function(){let e=y({path$:["M15 19v-2a2 2 0 0 1 2 -2h2","M15 5v2a2 2 0 0 0 2 2h2","M5 15h2a2 2 0 0 1 2 2v2","M5 9h2a2 2 0 0 0 2 -2v-2"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...e,...this.props}}
  />`});u("iconMaximize",function(){let e=y({path$:["M4 8v-2a2 2 0 0 1 2 -2h2","M4 16v2a2 2 0 0 0 2 2h2","M16 4h2a2 2 0 0 1 2 2v2","M16 20h2a2 2 0 0 0 2 -2v-2"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...e,...this.props}}
  />`});u("iconStackFront",function(){let e=y({path$:["M12 4l-8 4l8 4l8 -4l-8 -4","M8 14l-4 2l8 4l8 -4l-4 -2","M8 10l-4 2l8 4l8 -4l-4 -2"],style$:()=>`
        path:nth-of-type(1) { fill: currentColor; }
        ${this.props.style$?.()||this.props.style||""}
      `,viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...e,...this.props}}
  />`});u("iconRemove",function(){let e=y({path$:["M10 10l4 4m0 -4l-4 4","M12 3c7.2 0 9 1.8 9 9s-1.8 9 -9 9s-9 -1.8 -9 -9s1.8 -9 9 -9z"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...e,...this.props}}
  />`});u("iconDelete",function(){let e=y({path$:["M4 7l16 0","M10 11l0 6","M14 11l0 6","M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12","M9 7l0 -3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1l0 3"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...e,...this.props}}
  />`});u("iconLock",function(){let e=y({path$:["M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z","M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0","M8 11v-4a4 4 0 1 1 8 0v4"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...e,...this.props}}
  />`});u("aScreen",function(){re(),V();let e=x(localStorage).config_isSingleWindow$,t=w(()=>`
    /* @scope { */
    #screen {
      &${N.defaultTheme}

      & {
        display: flex;
        width: 100dvw;
        height: 100dvh;

        @media (orientation: landscape) {
          flex-direction: row; /* -reverse; */
        }
        @media (orientation: portrait) {
          flex-direction: column;
        }
        /**/
      }
    }

    #workspaces {
      flex: 1;
      position: relative;

      /* system views; above all; widgets view would be similar but below it with z-i:1 while sysviews z-i:2 */
      #system-views {
        display: block !important; /* NO pois vai ficar sobre todos n vai poder selecionar txt etc*/
        display: none !important; /* TODO block somente qdo rota de system der match */
        position: absolute;
        inset: 0;
        z-index: 1;
        overflow: hidden;
      }

      #windows {
        display: flex !important;
        @media (orientation: portrait) {
          flex-direction: column;
        }
        position: absolute;
        inset: 0;
        z-index: 0;
        overflow: hidden;
      }
    }

    #unified-toolbar {
      display: flex !important;
      @media (orientation: portrait) {
        min-height: 50px;
      }
      @media (orientation: landscape) {
        flex-direction: column;
        min-width: 50px;
      }
      flex: 0 0 auto;
      background-color: ${g.colors.mg};
      /**/
    }
  `),o=J("unifiedToolbarRef",null);return this.h`
    <div id="screen" class=${{"multi-window":!e(),[U.defaultTheme]:!0}}>
      <style>${t()}</style>
      <div id='workspaces'>
        <a-windows id='windows' />
        <system-views id='system-views' />
      </div>
      <unified-toolbar ref=${o} id='unified-toolbar' />
    </div>
  `});u("systemViews",function(){return this.h`
    <div
      style=${`
        background-color: ${g.colors.bg};
        display: none; /* while not at route */
      `}
    >
      system views
    </div>
  `});u("aWindows",function(){let{session_openWorkspaceKeys$:e}=x(localStorage),t=B([]);K(({track:i})=>{let s=i(()=>e());t(r=>r.concat(s.filter(n=>!r.includes(n))))});let o=w(()=>e().reduce((i,s,r)=>({...i,[s]:r+1}),{}));return this.h`
    ${t().map(i=>this.h({key:i})`<workspace-window key=${i} props=${{workspaceKey:i,mruRankByWsKey$:o}} />`)}
    <windows-background />
  `});u("windowsBackground",function(){return this.h`
    <div
      id='windows-background'
      style=${`
        background-color: ${g.colors.bg};
        background-image: url(${pe});
        background-position: center;
        background-repeat: no-repeat;
        background-size: contain;
        display: flex;
        align-items: flex-end;
        justify-content: center;
        text-align: center;
        padding: clamp(24px, 6vmin, 80px);
        color: ${g.colors.mgFont};
        z-index: 0;
        inset: 0;
        position: absolute;
      `}
    >
      <style>${`
        #windows-background {
          @media ${O.breakpoints.desktop} {
            background-origin: content-box;
          }
        }
      `}</style>
      Please open a napp
    </div>
  `});u("workspaceWindow",function(){let e=x(localStorage),{[`session_workspaceByKey_${this.props.workspaceKey}_openAppKeys$`]:t}=e,o=B([]);K(({track:s})=>{let r=s(()=>t());o(n=>n.concat(r.filter(a=>!n.includes(a))))});let i=w(()=>(t()??[]).reduce((s,r,n)=>({...s,[r]:`${this.props.mruRankByWsKey$()[this.props.workspaceKey]}-${n+1}`}),{}))();return this.h`
    ${o().map(s=>{let r=i[s];return this.h({key:s})`
      <app-window key=${s} props=${{appKey:s,wsKey:this.props.workspaceKey,mruRank:r}} />
      `})}
  `});u("appWindow",function(){let e=x(localStorage),{[`session_appByKey_${this.props.appKey}_id$`]:t,[`session_appByKey_${this.props.appKey}_visibility$`]:o,[`session_appByKey_${this.props.appKey}_route$`]:i,[`session_workspaceByKey_${this.props.wsKey}_userPk$`]:s}=e,r=w(()=>(s()||"")&&X(s(),50)),n=w(()=>D(t(),r())),a=w(()=>o()==="closed"),p=B(null),l=B("about:blank"),d=B(null),$=B("about:blank"),{cachingProgress$:c}=P("<napp-assets-caching-progress-bar>",{cachingProgress$:{}}),{requestVaultMessage:m}=Z(),f=A("<permission-dialog>"),{requestPermission:_}=f,{openApp:h}=A("useAppRouter");if(K(async({track:b,cleanup:I})=>{let[v,k]=b(()=>[a(),p()]);if(v){c({}),p(null),$("about:blank"),d(null),l("about:blank");return}if(!k)return;let S=i()||"";S&&i("");let C=new AbortController;I(()=>C.abort()),await ie(r(),t(),n(),S,p(),d(),$,c,m,_,h,{signal:C.signal,isSingleNapp:!1}),l(`//${n()}.${window.location.host}/~~napp`)},{after:"rendering"}),!a())return this.h`
    <div
      style=${`
        background-color: ${g.colors.bg};
      `}
      class=${{open:o()==="open",scope_khjha3:!0,[`mru-rank-${this.props.mruRank??"none"}`]:!!this.props.mruRank}}
    >
    <style>
      .scope_khjha3 {
        & {
          display: none; /* minimized or closed */
          z-index: 1;
          flex: 0 1 100%;

          @media (orientation: portrait) {
            width: 100%;
          }
          @media (orientation: landscape) {
            height: 100%;
          }
          /**/
          iframe {
            &.tilde-tilde-napp-page { display: none; }

            &.napp-page {
              border: none;
              width: 100%;
              height: 100%;
              display: block; /* ensure it's not inline */
            }
          }
        }
        &.mru-rank-1-1 { order: 0; }
        &.mru-rank-1-2 { order: 1; }
        &.mru-rank-1-3 { order: 2; }
        &.mru-rank-2-1 { order: 3; }
        &.mru-rank-2-2 { order: 4; }
        &.mru-rank-2-3 { order: 5; }
        &.mru-rank-3-1 { order: 6; }
        &.mru-rank-3-2 { order: 7; }
        &.mru-rank-3-3 { order: 8; }
        &.mru-rank-1-1.open, &.mru-rank-2-1.open, &.mru-rank-3-1.open {
          display: block;
        }
        #screen.multi-window &.open {
          &.mru-rank-1-2, &.mru-rank-2-2, &.mru-rank-3-2 {
            display: block;
          }
          /* thin or thinner (shrinking number) */
          @media (max-aspect-ratio: 8/16) {
            &.mru-rank-1-3, &.mru-rank-2-3, &.mru-rank-3-3 {
              display: block;
            }
          }
          /* short or shorter (growing number) */
          @media (min-aspect-ratio: 16/8) {
            &.mru-rank-1-3, &.mru-rank-2-3, &.mru-rank-3-3 {
              display: block;
            }
          }
        }
      }
    </style>
    <napp-assets-caching-progress-bar />
    <iframe
      class='napp-page'
      allow='fullscreen; screen-wake-lock; ambient-light-sensor;
             autoplay; midi; encrypted-media;
             accelerometer; gyroscope; magnetometer; xr-spatial-tracking;
             clipboard-read; clipboard-write; web-share;
             camera; microphone;
             geolocation;
             bluetooth;
             payment'
      ref=${d}
      src=${$()}
    />
    <iframe
      class='tilde-tilde-napp-page'
      ref=${p}
      src=${l()}
    />
    </div>
  `});u("unifiedToolbar",function(){let e=H();return this.h`
    <style>${`
      /* @scope { */
      #unified-toolbar {
        toolbar-active-avatar {
          flex: 0 0 auto;
          display: flex !important;

          @media (orientation: portrait) {
            padding-left: 7px; */
          }
          @media (orientation: landscape) {
            flex-direction: column;
            padding-top: 7px; */
            /**/
          }

          align-items: center;
        }

        toolbar-app-list {
          flex: 1;
          display: flex !important;
          align-items: center;
          overflow: auto hidden;
          gap: 7px;
          padding: 0 7px;

          @media (orientation: landscape) {
            flex-direction: column;
            overflow: hidden auto;
            padding: 7px 0;
          }

          ${e.get(!1).hasOverlay?"":`
            scrollbar-color: rgba(255 255 255 / 0.2) transparent; /* thumb track */
            transition: scrollbar-color .3s;
            &:hover {
              scrollbar-color: rgba(255 255 255 / 0.5) transparent;
            }

            scrollbar-width: thin;
            @media (orientation: landscape) {
              /*
                scrollbar-gutter on chrome works just for vertical scrollbars due to a bug
                Considering we can't reliably set styles for specific browsers, we are going
                to restrict it to landscape for everyone
              */
              scrollbar-gutter: stable;
              scrollbar-width: unset; /* or else left prop won't work correctly */
              toolbar-app-launcher > div {
                position: relative;
                left: ${Math.floor(e.get(!1).width/2)}px;
              }
            }
          `}
        }
        /**/
      }
    `}</style>
    <toolbar-active-avatar />
    <toolbar-app-list />
  `});u("toolbarActiveAvatar",function(){return P("<a-menu>",{isOpen$:!1,anchorRef$:null,open(){this.isOpen$(!0)},close(){this.isOpen$(!1)},toggle(){this.isOpen$(e=>!e)}}),this.h`
    <toolbar-menu />
    <toolbar-avatar />
  `});u("toolbarMenu",function(){let e=x(localStorage),{session_openWorkspaceKeys$:t,session_workspaceKeys$:o}=e,{close:i}=P("<a-menu>"),s=T(),{requestVaultMessage:r}=Z(),n=B({}),a=B({}),p=e.session_defaultUserPk$,l=w(()=>{let h=[],b={};o().forEach(v=>{let k=e[`session_workspaceByKey_${v}_userPk$`]();if(k!=null){let S=e[`session_accountByUserPk_${k}_profile$`](),C=e[`session_accountByUserPk_${k}_isLocked$`]();b[k]===void 0&&(b[k]=0),b[k]++,h.push({userPk:k,wsKey:v,profile:S,name:S?.name||S?.npub||k!==p()&&M(k)||"Default User",isLocked:C,index:b[k],totalCount:b[k]})}});let I={};return h.forEach(v=>{I[v.userPk]===void 0&&(I[v.userPk]=0),I[v.userPk]++}),h.forEach(v=>{v.totalCount=I[v.userPk]}),h}),d=w(()=>{let h=t()[0];return e[`session_workspaceByKey_${h}_userPk$`]()}),{disableStartAtVaultHomeWorkaroundThisTime:$}=A("vaultMessenger"),c=R(async(h,b,I)=>{if(h!==d()){let v=[...t()],k=[b,...v.filter(S=>S!==b)];e.session_openWorkspaceKeys$(k)}if(I){let v=`${h}-${b}`;n({...n(),[v]:!0}),a({...a(),[v]:null});try{let k=M(h),S=await r({code:"UNLOCK_ACCOUNT",payload:{pubkey:k}},{timeout:12e4,instant:!0});if(S.error||!S.payload?.isRouteReady)throw new Error(S.error?.message||"Failed to unlock account");i(),$(),s.open()}catch(k){a({...a(),[v]:k.message||"Error unlocking"}),setTimeout(()=>{a(S=>{let C={...S};return delete C[v],C})},3e3)}finally{n(k=>{let S={...k};return delete S[v],S})}}else i()}),m=R(()=>{i(),s.open()}),f=P("<a-menu>"),_=y({render:R(function(){return this.h`<div id='user-selection-menu'>
        <style>${`
          #user-selection-menu {
            display: flex;
            flex-direction: column;
            padding: 4px;
            min-width: 200px;
            max-width: 230px;
            background-color: ${g.colors.mg};
            color: ${g.colors.mgFont};
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            overflow: hidden;

            .user-item {
              border-radius: 6px;
              display: flex;
              align-items: center;
              padding: 5px 8px;
              cursor: pointer;
              transition: background-color 0.2s;
            }
            .user-item.active {
              background-color: rgba(255, 255, 255, 0.05);
            }
            .user-item:hover {
              background-color: rgba(255, 255, 255, 0.1);
            }
            .user-avatar {
              margin-right: 12px;
              flex-shrink: 0;
              width: 40px;
              height: 40px;
              position: relative;
            }
            .user-name {
              font-size: 15rem;
              font-weight: 600;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            }
            .user-unlock-hint {
              font-size: 12rem;
              font-style: italic;
              color: rgba(255, 255, 255, 0.6);
              margin-top: 2px;
            }
            .user-unlock-error {
              font-size: 12rem;
              font-style: italic;
              color: ${g.colors.error};
              margin-top: 2px;
            }
            .user-item.unlocking {
              animation: pulsate 2s ease-in-out infinite;
            }
            @keyframes pulsate {
              0% { background-color: rgba(255, 255, 255, 0.05); }
              50% { background-color: rgba(255, 255, 255, 0.15); }
              100% { background-color: rgba(255, 255, 255, 0.05); }
            }
            .user-index-badge {
              position: absolute;
              bottom: -2px;
              left: -2px;
              width: 16px;
              height: 16px;
              background-color: ${g.colors.accentSecondary};
              border-radius: 50%;
              display: flex;
              justify-content: center;
              align-items: center;
              color: white;
              font-size: 10px;
              font-weight: bold;
            }
            .lock-icon {
              position: absolute;
              bottom: -2px;
              right: -2px;
              width: 16px;
              height: 16px;
              background-color: ${g.colors.accentPrimary};
              border-radius: 50%;
              display: flex;
              justify-content: center;
              align-items: center;
              color: white;
            }
            .lock-icon svg {
              width: 10px;
              height: 10px;
            }
            .add-user-button {
              border-radius: 6px;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 5px 8px;
              cursor: pointer;
              transition: background-color 0.2s;
              margin-top: 4px;
              background-color: rgba(255, 255, 255, 0.05);
            }
            .add-user-button:hover {
              background-color: rgba(255, 255, 255, 0.1);
            }
            .add-user-icon {
              width: 20px;
              height: 20px;
              display: flex;
              justify-content: center;
              align-items: center;
              border-radius: 50%;
              border: 2px solid ${g.colors.mgFont};
              color: ${g.colors.mgFont};
              flex-shrink: 0;
            }
            .add-user-icon svg {
              width: 12px;
              height: 12px;
            }
          }
        `}</style>
        ${l().map(h=>{let b=`${h.userPk}-${h.wsKey}`,I=n()[b],v=a()[b];return this.h({key:b})`<div
            class=${{"user-item":!0,active:h.userPk===d(),unlocking:I}}
            onclick=${()=>c(h.userPk,h.wsKey,h.isLocked)}
          >
            <div class="user-avatar">
              <a-avatar props=${{pk$:h.userPk,size:"32px",weight$:"duotone",strokeWidth$:1}} />
              ${h.totalCount>1?this.h`<div class="user-index-badge">${h.index}</div>`:""}
              ${h.isLocked?this.h`<div class="lock-icon">
                    <icon-lock props=${{size:"10px"}} />
                  </div>`:""}
            </div>
            <div>
              <div class="user-name">${h.name}</div>
              ${h.isLocked?this.h`<div class=${v?"user-unlock-error":"user-unlock-hint"}>
                    ${v||"Touch to unlock"}
                  </div>`:""}
            </div>
          </div>`})}
        <div class="add-user-button" onclick=${m}>
          <div class="add-user-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </div>
        </div>
      </div>`}),style$:()=>CSS.supports("position-anchor","--test")?`& {
        position-anchor: --toolbar-avatar-menu;
        position-area: top span-right;
        margin: 0 0 6px -5px;
        @media (orientation: landscape) {
          position-area: left span-bottom;
          margin: -5px 8px 0 0;
        }
      }`:`& {
        position: fixed;
        z-index: 1000;
        margin: 0 0 6px -5px;
        @media (orientation: landscape) {
          margin: -5px 8px 0 0;
        }
      }`,...f});return this.h`<a-menu props=${_} />`});u("toolbarAvatar",function(){let e=x(localStorage),{session_openWorkspaceKeys$:t,session_workspaceKeys$:o}=e,i=w(()=>{let c=t()[0];return e[`session_workspaceByKey_${c}_userPk$`]()}),s=w(()=>{let c=i();return c?e[`session_accountByUserPk_${c}_isLocked$`]():!1}),r=w(()=>{let c=i(),m=t()[0];if(!c||!m)return{index:1,showBadge:!1};let f=0,_=0;for(let h of o())e[`session_workspaceByKey_${h}_userPk$`]()===c&&_++;for(let h of o())if(e[`session_workspaceByKey_${h}_userPk$`]()===c&&(f++,h===m))break;return{index:f,showBadge:_>1}}),{toggle:n,close:a,anchorRef$:p}=P("<a-menu>"),l=T(),d=w(()=>i()!==e.session_defaultUserPk$()||t().length>1);K(({track:c})=>{c(()=>d())||a()});let $=R(()=>{if(d())return n();l.open()});return this.h`<div
    ref=${p}
    onclick=${$}
    style=${`
      anchor-name: --toolbar-avatar-menu;
      color: ${g.colors.mgFont};
      width: 40px; height: 40px; display: flex; justify-content: center; align-items: center;
      border-radius: 50%;
      position: relative;
    `}
  >
    <a-avatar props=${{pk$:i,size:"32px",weight$:"duotone",strokeWidth$:1}} />
    ${r().showBadge?this.h`<div style=${`
          position: absolute;
          bottom: -2px;
          left: -2px;
          width: 16px;
          height: 16px;
          background-color: ${g.colors.accentSecondary};
          border-radius: 50%;
          display: flex;
          justify-content: center;
          align-items: center;
          color: white;
          font-size: 10px;
          font-weight: bold;
        `}>
          ${r().index}
        </div>`:""}
    ${s()?this.h`<div style=${`
          position: absolute;
          bottom: -2px;
          right: -2px;
          width: 16px;
          height: 16px;
          background-color: ${g.colors.accentPrimary};
          border-radius: 50%;
          display: flex;
          justify-content: center;
          align-items: center;
          color: white;
        `}>
          <icon-lock props=${{size:"10px"}} />
        </div>`:""}
  </div>`});u("toolbarAppList",function(){return P("<a-menu>",()=>({isOpenedByLongPress:!1,isOpen$:!1,open(){this.isOpen$(!0)},close(){this.isOpen$(!1)},app$:{key:""},toggleMenu(e){this.app$().key===e.key?(this.app$(e),this.isOpen$(o=>!o)):(this.close(),window.requestIdleCallback(()=>{this.app$(e),this.open()},{timeout:150}))}}),{isStatic:!1}),this.h`
    <toolbar-pinned-apps />
    <toolbar-unpinned-apps />
  `});u("toolbarPinnedApps",function(){let e=x(localStorage),{session_openWorkspaceKeys$:t}=e,o=w(()=>{let i=t()[0];return(e[`session_workspaceByKey_${i}_pinnedAppIds$`]()||[]).reduce((r,n,a)=>{let p=a+1;return e[`session_workspaceByKey_${i}_appById_${n}_appKeys$`]().forEach(l=>{r.push({appId:n,appKey:l,appIndex:p})}),r},[])});return this.h`${o().map(i=>this.h({key:i.appKey})`<toolbar-app-launcher key=${i.appKey} props=${i} />`)}`});u("toolbarUnpinnedApps",function(){let e=x(localStorage),{session_openWorkspaceKeys$:t}=e,o=w(()=>{let i=t()[0],s=(e[`session_workspaceByKey_${i}_pinnedAppIds$`]()||[]).length;return(e[`session_workspaceByKey_${i}_unpinnedAppIds$`]()||[]).reduce((n,a,p)=>{let l=p+1+s;return e[`session_workspaceByKey_${i}_appById_${a}_appKeys$`]().forEach(d=>{n.push({appId:a,appKey:d,appIndex:l})}),n},[])});return this.h`
    <app-launchers-menu />
    ${o().map(i=>this.h({key:i.appKey})`<toolbar-app-launcher key=${i.appKey} props=${i} />`)}
  `});u("appLaunchersMenu",function(){let e=P("<a-menu>"),t=x(localStorage),o=y(()=>({...e,openApp(){let{visibility:i,key:s,workspaceKey:r}=this.app$();if(i==="open")throw new Error("App is already open");this.close(),t[`session_appByKey_${s}_visibility$`]("open"),t[`session_workspaceByKey_${r}_openAppKeys$`]((n,a)=>{let p=n.indexOf(s);return p!==-1&&n.splice(p,1),n.unshift(s),n[a]=Math.random(),n})},bringToFirst(){let{visibility:i,key:s,workspaceKey:r}=this.app$(),n=t[`session_workspaceByKey_${r}_openAppKeys$`]();if(i!=="open")throw new Error("Can only bring to first when app is open");if(n[0]===s)throw new Error("App is already first");this.close();let a;t[`session_workspaceByKey_${r}_openAppKeys$`]((p,l)=>(a=p.indexOf(s),a>-1&&(p.splice(a,1),p.unshift(s),p[l]=Math.random()),p))},minimizeApp(){let{visibility:i,key:s,workspaceKey:r}=this.app$();if(i!=="open")throw new Error("Can only minimize an open app");this.close();let n;t[`session_appByKey_${s}_visibility$`]("minimized"),t[`session_workspaceByKey_${r}_openAppKeys$`]((a,p)=>(n=a.indexOf(s),n>-1&&(a.splice(n,1),a[p]=Math.random()),a))},closeApp(){let{visibility:i,key:s,workspaceKey:r}=this.app$();if(i==="closed")throw new Error("App is already closed");this.close(),t[`session_appByKey_${s}_visibility$`]("closed"),t[`session_workspaceByKey_${r}_openAppKeys$`]((n,a)=>{let p=n.indexOf(s);return p!==-1&&(n.splice(p,1),n[a]=Math.random()),n})},removeApp({isDeleteStep:i=!1}={}){let{id:s,key:r,workspaceKey:n}=this.app$(),a=t[`session_workspaceByKey_${n}_appById_${s}_appKeys$`]();if(!i&&a.length<=1)throw new Error("Cannot remove the last instance of an app");i||this.close(),t[`session_workspaceByKey_${n}_openAppKeys$`]((d,$)=>{let c=d.indexOf(r);return c!==-1&&(d.splice(c,1),d[$]=Math.random()),d});let p=a.filter(d=>d!==r);t[`session_workspaceByKey_${n}_appById_${s}_appKeys$`](p),t[`session_appByKey_${r}_id$`](void 0),t[`session_appByKey_${r}_visibility$`](void 0),t[`session_appByKey_${r}_route$`](void 0);let l=!1;for(let d of t.session_workspaceKeys$())if(l=t[`session_workspaceByKey_${d}_appById_${s}_appKeys$`]().some($=>$!==r),l)break;l||(t[`session_appById_${s}_icon$`](void 0),t[`session_appById_${s}_name$`](void 0),t[`session_appById_${s}_description$`](void 0),t[`session_appById_${s}_relayHints$`](void 0))},async maybeClearAppStorage(){let{id:i,workspaceKey:s}=this.app$(),r=t[`session_workspaceByKey_${s}_userPk$`](),n=t.session_workspaceKeys$().filter(d=>d!==s),a=!0,p=!0;for(let d of n)if(t[`session_workspaceByKey_${d}_appById_${i}_appKeys$`]()?.length>0&&(p=!1,t[`session_workspaceByKey_${d}_userPk$`]()===r)){a=!1;break}if(a){let d=X(r,50),$=D(i,d);await l($)}p&&await(await j.create(i)).clearAppFiles();function l(d){let $=Promise.withResolvers(),c=document.createElement("iframe");c.style.display="none";let m,f=()=>{m&&clearTimeout(m),window.removeEventListener("message",h),document.body.removeChild(c)},_=`${window.location.protocol}//${d}.${window.location.host}`,h=b=>{b.origin===_&&(b.data.code==="DATA_CLEARED"&&(f(),$.resolve()),b.data.code==="DATA_CLEAR_ERROR"&&(f(),$.reject(b.data.error)))};return window.addEventListener("message",h),c.src=`${_}/~~napp#clear`,document.body.appendChild(c),m=setTimeout(()=>{f(),$.reject(new Error("Data clear timeout"))},5e3),$.promise}},async deleteApp(){let{id:i,workspaceKey:s}=this.app$();if(t[`session_workspaceByKey_${s}_appById_${i}_appKeys$`]().length!==1)throw new Error("Can only delete an app that has a single instance");this.removeApp({isDeleteStep:!0}),this.close(),t[`session_workspaceByKey_${s}_pinnedAppIds$`](n=>(n??[]).filter(a=>a!==i)),t[`session_workspaceByKey_${s}_unpinnedAppIds$`](n=>(n??[]).filter(a=>a!==i)),t[`session_workspaceByKey_${s}_appById_${i}_appKeys$`](void 0),await this.maybeClearAppStorage()},render:R(function(){let{openApp:i,bringToFirst:s,minimizeApp:r,closeApp:n,removeApp:a,deleteApp:p,app$:l}=o,{id:d,key:$,visibility:c,workspaceKey:m}=l(),f=t[`session_workspaceByKey_${m}_openAppKeys$`](),_=t[`session_workspaceByKey_${m}_appById_${d}_appKeys$`]();return this.h`<div id='scope_pfgf892'>
        <style>${`
          #scope_pfgf892 {
            & > div {
              &.invisible { display: none; }
              display: flex;
              align-items: center;
            }
            .icon-wrapper-271yiduh {
              flex: 0 1 min-content;
              margin: 10px;
            }
            .menu-label {
              flex: 1;
              min-height: 30px;
              padding: 10px 10px 10px 3px;
            }
          }
        `}</style>
        <div class=${{invisible:c==="open"}}>
          <div class='icon-wrapper-271yiduh'><icon-maximize props=${{size:"16px"}} /></div>
          <div class='menu-label' onclick=${i}>${c==="closed"?"Open":"Maximize"}</div>
        </div>
        <div class=${{invisible:c!=="open"||f[0]===$}}>
          <div class='icon-wrapper-271yiduh'><icon-stack-front props=${{size:"16px"}} /></div>
          <div class='menu-label' onclick=${s}>Bring to First</div>
        </div>
        <div class=${{invisible:c!=="open"}}>
          <div class='icon-wrapper-271yiduh'><icon-minimize props=${{size:"16px"}} /></div>
          <div class='menu-label' onclick=${r}>Minimize</div>
        </div>
        <div class=${{invisible:c==="closed"}}>
          <div class='icon-wrapper-271yiduh'><icon-close props=${{size:"16px"}} /></div>
          <div class='menu-label' onclick=${n}>Close</div>
        </div>
        <div class=${{invisible:_.length<=1}}>
          <div class='icon-wrapper-271yiduh'><icon-remove props=${{size:"16px"}} /></div>
          <div class='menu-label' onclick=${a}>Remove</div>
        </div>
        <div class=${{invisible:_.length!==1}}>
          <div class='icon-wrapper-271yiduh'><icon-delete props=${{size:"16px"}} /></div>
          <div class='menu-label' onclick=${p}>Delete</div>
        </div>
      </div>`}),style$:()=>{let i=`& {
        position-anchor: --app-launchers-menu;
        position-area: top span-right;
        margin-bottom: 6px;
        @media (orientation: landscape) {
          position-area: left span-bottom;
          margin-right: 7px;
        }
      }`,s=`& {
        position: fixed;
        z-index: 1000;
        margin-bottom: 6px;
        @media (orientation: landscape) {
          margin-right: 7px;
        }
      }`,r=`
        background-color: ${g.colors.mg};
        color: ${g.colors.mgFont};
        min-width: 120px;
        display: flex;
        flex-direction: column;
      `;return`& { ${CSS.supports("position-anchor","--test")?i:s} ${r} }`},anchorRef$:()=>o.app$()?.ref}));return this.h`<a-menu props=${o} />`});u("toolbarAppLauncher",function(){let e=x(localStorage),t=q("hardcoded_newAppIdsObj"),o=E(this.props.appIndex),i=B(),s=w(()=>({id:this.props.appId,key:this.props.appKey,workspaceKey:e.session_openWorkspaceKeys$()[0],index:o(),visibility:e[`session_appByKey_${this.props.appKey}_visibility$`](),icon:e[`session_appByKey_${this.props.appKey}_icon$`](),isNew:!!t()[this.props.appId],ref:i()})),{toggleMenu:r,app$:n}=P("<a-menu>"),a=()=>r({...s()}),p=w(()=>n().key===s().key?"--app-launchers-menu":"none"),l=w(()=>{switch(s().visibility){case"open":return g.colors.fgPrimary;case"minimized":return g.colors.fgSecondary;case"closed":default:return g.colors.fg}});return this.h`<div
    ref=${i}
    onclick=${a}
    id=${`scope_df81hd_${s().key}`}
    style=${`
      anchor-name: ${p()};
      background-color: transparent;
      width: 40px;
      height: 40px;
      display: flex;
      justify-content: center;
      align-items: center;
      position: relative;
    `}
  >
    <style>${`
      #scope_df81hd_${s().key} {
        & {
          flex-shrink: 0;
        }
        .squircle {
          position: absolute;
          width: 100%;
          height: 100%;
          z-index: 0;

          path {
            fill: ${l()};
            stroke: none;
          }
        }
      }
    `}</style>
    ${this.s`<svg viewbox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" class="squircle">
      <path d="M 0, 100 C 0, 12 12, 0 100, 0 S 200, 12 200, 100 188, 200 100, 200 0, 188 0, 100"></path>
    </svg>`}
    <div style='padding: 4px; width: 100%; height: 100%; z-index: 1; cursor: pointer;'>
      <app-icon props=${{app$:s}} />
    </div>
  </div>`});u("f-to-signals",function(){let e=this.props.from$??E(this.props.from),t=w(()=>(Array.isArray(e.get())?e.get().flat():Object.keys(e.get())).sort().join(":"));return this.h`${this.h({key:t.get()})`<f-to-signals-wrapped key=${t.get()} props=${{...this.props,from$:e}} />`}`});u("f-to-signals-wrapped",function(){let{render:e,...t}=this.props;return e.call(this,G(t))});async function de(e,t,o){if(!e||!t||o==null)throw new Error("appId, name and eKind are required");if(o===-1)return L("get",[[e,t,-1]],"permissions").then(p=>!!p.result);let i=IDBKeyRange.bound([e,t,-1],[e,t,o]),s=Promise.withResolvers();L("openKeyCursor",[i],"permissions",null,{p:s});let r,n,a=[e,t,o];for(;r=(await s.promise).result;){if(n=r.primaryKey[2],n===-1||n===o)return!0;Object.assign(s,Promise.withResolvers()),r.continue(a)}return!1}async function ue(e,t,o){if(!e||!t||o==null)throw new Error("appId, name and eKind are required");return L("put",[{appId:e,name:t,eKind:o}],"permissions")}u("iconX",function(){let e=y({path$:["M18 6l-12 12","M6 6l12 12"],viewBox$:"2 2 20 20"});return this.h`<a-svg
    props=${{...e,...this.props}}
  />`});u("permissionDialog",function(){let e=A("<permission-dialog>",()=>({isOpen$(){return this.queue$().length>0},close(){let o=this.queue$().length,i=Promise.resolve();for(;o-- >0;)i=i.then(()=>this.resolveCurrent(!1))},queue$:[],getPermissionId(o){return`${o.app.id}:${o.name}:${o.eKind??""}`},isSingularPermission(o){return o.eKind==null||o.eKind===5||o.eKind===62},addPermissionRequest(o){this.queue$(i=>{let s;return this.isSingularPermission(o)&&(s=i.find(r=>r.id===o.id))?(s.promise.then(o.resolve).catch(o.reject),i):(i.push({id:o.id,app:{id:o.app.id,napp:o.app.napp,alias:o.app.alias,name:o.app.name,icon:{fx:o.app.icon?.fx,url:o.app.icon?.url}},name:o.name,eKind:o.eKind,meta:{...o.meta},promise:o.promise,resolve:o.resolve,reject:o.reject}),i)})},removeCurrent(o){if(this.queue$().length===0)return;let i=o??this.queue$()[0];this.queue$(s=>o?s.filter(r=>r.id!==i.id):s.slice(1))},async resolveCurrent(o,i){if(this.queue$().length===0)return;let s=i??this.queue$()[0];if(o){if(this.isSingularPermission(s)){s.resolve(!0),this.removeCurrent(i);return}await ue(s.app.id,s.name,s.eKind),s.resolve(!0),this.removeCurrent(i)}else s.reject(new Error("Permission denied")),this.removeCurrent(i)},async queryPermission(o){return o.eKind==null||o.app.id&&o.name==="openApp"?!1:de(o.app.id,o.name,o.eKind)},async requestPermission(o){if(await this.queryPermission(o))return!0;let s=Promise.withResolvers();return this.addPermissionRequest({...o,...s,id:this.getPermissionId(o)}),s.promise}})),t=y(()=>({isOpen$:e.isOpen$,close:e.close.bind(e),shouldAlwaysDisplay$:!0,render:R(function(){return this.h`<permission-dialog-stack />`})}));return this.h`<a-modal props=${t} />`});u("permissionDialogStack",function(){let e=x(localStorage),t=A("<permission-dialog>"),o=P("<permission-dialog-stack>",()=>({resolveCurrent:t.resolveCurrent.bind(t),eKindToText:{0:"profiles",1:"short text notes",3:"follow lists",4:"(legacy) direct messages",6:"short text renotes",7:"reactions",13:"message seals",14:"(public) chat messages",15:"(public) file decryption keys",16:"renotes",20:"pictures",21:"videos",22:"short vertical videos",1018:"poll responses",1059:"recipient directions",1068:"polls",1111:"comments",1222:"short voice notes",1244:"short voice comments",1984:"misconduct reports",7376:"nutzap redemption logs",9321:"nutzaps",9734:"bitcoin pre-payment data",9735:"bitcoin receipts",10002:"home server configurations",10019:"nutzap receiving addresses",27235:"API authentication requests",30008:"profile badges",30009:"profile badge definitions",30023:"long text notes",30311:"livestreams",30402:"classified listings",30403:"(draft) classified listings",31922:"date events",31923:"time events",31924:"calendars",31925:"event RSVPs",34600:"files",37348:"napp stalls",37349:"(next) napp stalls",37350:"(draft) napp stalls",37448:"napp bundles",37449:"(next) napp bundles",37450:"(draft) napp bundles"},getEKindToText(i,s){if(s==="readProfile")return"your profile";let r=this.eKindToText[i];return r||(i==null?r="an item":r=`kind ${i} items`),r},nameToText:{readProfile:"read",signEvent:"publish",encrypt:"encrypt",decrypt:"decrypt",openApp:"open"},getNameToText(i){return this.nameToText[i]||i},getPemissionText(i,s,r){let n;if(s===22242)n="tell servers who you are";else if(s===5){let a=r?.params?.[0];if(!a)throw new Error("Missing event parameter for eKind 5 permission");let p=["e","a"],l=a.tags.filter(d=>p.includes(d[0])).length||1;n=`delete ${l} ${l===1?"item":"items"}`}else if(s===62){let a=event.tags.filter(l=>l[0]==="relay"),p=a.some(l=>l==="ALL_RELAYS")?1/0:a.length||1;n=`delete ALL your items from ${p===1/0?"ALL servers":`${p} ${p===1?"server":"servers"}`}`}else if(i==="openApp"){let{targetApp:a}=r??{};if(!a)throw new Error("Missing app parameter for openApp permission");let{[`session_appById_${a.id}_name$`]:p}=e,l=a.name||p()||a.alias||a.napp;if(l==null)throw new Error("Missing app name for openApp permission");n=`${this.getNameToText(i)} the ${l} napp`}if(!n){let a=this.getEKindToText(s,i);n=[this.getNameToText(i),a].filter(Boolean).join(" ")}return"Can I "+n+"?"},permissionRequests$(){return t.queue$()}}));return this.h`
    <style>${`
      #permission-dialog-stack {
        &${N.defaultTheme}

        display: flex;
        flex-direction: column;
        padding: 4px;
        min-width: 200px;
        @media ${O.breakpoints.desktop} {
          margin: 0 auto;
          max-width: 500px;
        }
        background-color: ${g.colors.mgLighter};
        color: ${g.colors.mgFont};
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        overflow: hidden;

        @media ${O.breakpoints.mobile} {
          border-radius: 0;
        }
      }
      /* this fixes syntax highlight */
    `}</style>
    <div id='permission-dialog-stack' class=${U.defaultTheme}>
      ${o.permissionRequests$().map((i,s)=>this.h({key:i.id})`
        <f-to-signals
          key=${i.id}
          props=${{from:["req","index"],req:i,index:s,render({req$:r,index$:n}){return this.h`<permission-dialog-card
                props=${{req$:r,index$:n}}
              />`}}}
        />
      `)}
    </div>
  `});u("permissionDialogCard",function(){let e=x(localStorage),t=P("<permission-dialog-stack>"),o=y(()=>({req$:this.props.req$,index$:this.props.index$,resolveCurrent(s){return t.resolveCurrent(s,this.req$())},isButtonsDisabled$:!1,allow(){return this.isButtonsDisabled$(!0),this.resolveCurrent(!0)},deny(){return this.isButtonsDisabled$(!0),this.resolveCurrent(!1)},permissionText$(){let s=this.req$();return t.getPemissionText(s.name,s.eKind,s.meta)},appName$(){let s=this.req$(),{[`session_appById_${s.app.id}_name$`]:r}=e,n=r();return s.app.name||n||s.app.alias||s.app.napp||"App"}})),i=y(()=>({app$:()=>({id:o.req$().app.id,index:"?"})}));return this.h`
    <style>${`
      .permission-dialog-card {
        border-radius: 8px;
        display: flex;
        align-items: center;
        padding: 5px 8px;
        transition: background-color 0.2s;
      }

      .permission-dialog-card:hover {
        background-color: rgba(255, 255, 255, 0.05);
      }

      .app-icon {
        margin-right: 12px;
        flex-shrink: 0;
        width: 40px;
        height: 40px;
        position: relative;
      }

      .app-info {
        flex: 1;
        min-width: 0;
        margin-right: 10px;
        top: 1px;
        position: relative;
      }

      .app-name {
        font-size: 15rem;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .permission-text {
        font-size: 16rem;
        line-height: 1.3;
        color: rgba(255, 255, 255, 0.7);
        margin-top: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .permission-actions {
        display: flex;
        gap: 8px;
        margin-left: 8px;
      }

      .permission-button {
        padding: 6px 12px;
        border-radius: 4px;
        font-size: 14rem;
        font-weight: 500;
        cursor: pointer;
        transition: background-color 0.2s, opacity 0.2s;
        border: none;
      }

      .permission-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .allow-button {
        background-color: ${g.colors.accentPrimary};
        color: white;
      }

      .allow-button:hover:not(:disabled) {
        background-color: ${g.colors.primary};
      }

      .deny-button {
        background-color: transparent;
        color: ${g.colors.mgFont};
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
      }

      .deny-button:hover:not(:disabled) {
        background-color: rgba(255, 255, 255, 0.1);
      }

      .deny-button svg {
        width: 16px;
        height: 16px;
      }

      @media ${O.breakpoints.mobile} {
        .permission-dialog-card {
          border-radius: 2px;
          padding: 8px 12px;
        }

        .app-icon {
          width: 32px;
          height: 32px;
          margin-right: 10px;
        }

        .app-name {
          font-size: 14rem;
        }

        .permission-text {
          font-size: 16rem;
        }

        .permission-actions {
          gap: 6px;
        }

        .permission-button {
          padding: 4px 8px;
          font-size: 13rem;
        }

        .deny-button {
          width: 28px;
          height: 28px;
        }

        .deny-button svg {
          width: 14px;
          height: 14px;
        }
      }
    `}</style>
    <div class='permission-dialog-card'>
      <div class="app-icon">
        <app-icon props=${i} />
      </div>
      <div class="app-info">
        <div class="app-name">${o.appName$()}</div>
        <div class="permission-text">${o.permissionText$()}</div>
      </div>
      <div class="permission-actions">
        <button
          class="permission-button allow-button"
          onclick=${o.allow}
          disabled=${o.isButtonsDisabled$()}
        >
          Allow
        </button>
        <button
          class="permission-button deny-button"
          onclick=${o.deny}
          disabled=${o.isButtonsDisabled$()}
        >
          <icon-x props={{ size: '16px' }} />
        </button>
      </div>
    </div>
  `});u("multiNapp",function(){return z(W),T(()=>({isOpen$:!1,open(){this.isOpen$(!0)},close(){this.isOpen$(!1)}})),this.h`
    <vault-modal />
    <permission-dialog />
    <a-screen />
  `});

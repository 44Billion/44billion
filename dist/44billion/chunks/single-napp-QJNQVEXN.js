import{a as _,b as S,d as A,e as I}from"./chunk-V7OLBYHW.js";import{c as k}from"./chunk-FZKW7XBH.js";import"./chunk-CUCTXUW3.js";import{l as y}from"./chunk-4YEM5IRY.js";import{b as $}from"./chunk-TBF35Z4Q.js";import{g as d,j as r,n as g,s as l,v as w}from"./chunk-EOHNSKYH.js";d("singleNapp",function(){let u=$(localStorage),{session_openWorkspaceKeys$:n}=u,t=n()[0];if(!t)throw new Error("User n/a");return A(()=>({isOpen$:!1,open(){this.isOpen$(!0)},close(){this.isOpen$(!1)}})),l("napp",()=>{let e,a=[window.location].map(s=>(s.pathname.replace(/\/\+{1,3}[^/?#]+\/?/,p=>(e=p.replace(/^\/|\/$/g,""),"")).replace(/\/$/,"")+s.search+s.hash).replace(/^([^?#])/,"/$1"))[0],m=k(e),o=y(m);return{wsKey:t,appId:o,initialRoute:a}}),this.h`
    <vault-modal />
    <single-napp-launcher />
  `});d("singleNappLauncher",function(){let{wsKey:u,appId:n,initialRoute:t}=l("napp"),e=$(localStorage),{[`session_workspaceByKey_${u}_userPk$`]:a}=e,m=g(()=>_(a(),50)),o=g(()=>{let i=a();return i?e[`session_subdomainByUserAndApp_${i}_${n}$`]():null}),s=r(),p=r("about:blank"),f=r(),h=r("about:blank"),{cachingProgress$:P}=l("<napp-assets-caching-progress-bar>",{cachingProgress$:{}}),{requestVaultMessage:B}=I();return w(async({cleanup:i})=>{if(o()==null){let c=e.session_subdomainNextId$()??0;e.session_subdomainNextId$(c+1),e[`session_subdomainByUserAndApp_${a()}_${n}$`](String(c))}let b=new AbortController;i(()=>b.abort()),await S(m(),n,o(),t,s(),f(),h,P,B,function(){throw new Error("Permission request not available in single napp mode yet")},function(){throw new Error("Open app not available in single napp mode yet")},{signal:b.signal,isSingleNapp:!0}),p(`//${o()}.${window.location.host}/~~napp`)},{after:"rendering"}),this.h`
      <style>
        iframe {
          &.tilde-tilde-napp-page { display: none; }

          &.napp-page {
            border: none;
            width: 100%;
            height: 100%;
            display: block; /* ensure it's not inline */
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
        ref=${f}
        src=${h()}
      />
      <iframe
        class='tilde-tilde-napp-page'
        ref=${s}
        src=${p()}
      />
  `});

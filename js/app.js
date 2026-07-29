const STATUS_URL="http://192.168.50.225/arduino/status";
const COMMAND_BASE_URL="http://192.168.50.225/arduino/";
const PRESSURE_STATUS_URL="http://192.168.50.51/pressure/pressure.php"
const REFRESH_INTERVAL_MS=2000;
const REQUEST_TIMEOUT_MS=8000;

const controls=[...document.querySelectorAll(".api-control")];
let controllerOnline=false;
let refreshInProgress=false;
let commandInProgress=false;
let hasConnectedBefore=false;
let consecutiveFailures=0;
let lastSuccessfulUpdate=0;
let commandMessageTimer=null;

let pressureRefreshInProgress=false;
let pressureEvents=[];
let lastPressureState="";
let lastPressureSignature="";

function el(id){return document.getElementById(id)}
function num(v,d){const n=Number(v);return Number.isFinite(n)?n.toFixed(d):"--"}

function setControls(){
    controls.forEach(b=>b.disabled=!(controllerOnline&&!commandInProgress));
}

function setConnectionState(online,showOverlay){
    controllerOnline=online;
    const badge=el("connectionBadge");
    const overlay=el("connectionOverlay");
    badge.className="connection-badge "+(online?"online":"");
    el("connectionText").textContent=online?"Online":"Delayed";

    if(online){
        overlay.classList.add("hidden");
        hasConnectedBefore=true;
    }else if(showOverlay||!hasConnectedBefore){
        overlay.classList.remove("hidden");
        el("connectionOverlayText").textContent=hasConnectedBefore
            ?"Connection lost. BANDYSTAT will reconnect automatically."
            :"Waiting for the Arduino Yún and Wi-Fi connection.";
    }else{
        overlay.classList.add("hidden");
    }

    el("diagnosticController").textContent=online?"Online":"Delayed";
    setControls();
}

function showMessage(message,type){
    clearTimeout(commandMessageTimer);
    const box=el("commandMessage");
    box.textContent=message;
    box.className="command-message"+(type?" "+type:"");
    if(type){
        commandMessageTimer=setTimeout(()=>{
            box.textContent=controllerOnline?"BANDYSTAT is online and ready.":"Reconnecting to BANDYSTAT…";
            box.className="command-message";
        },2800);
    }
}

async function requestText(url,timeout=REQUEST_TIMEOUT_MS){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeout);
    try{
        const sep=url.includes("?")?"&":"?";
        const response=await fetch(url+sep+"time="+Date.now(),{cache:"no-store",signal:controller.signal});
        if(!response.ok)throw new Error("HTTP "+response.status);
        const text=await response.text();
        if(!text.trim())throw new Error("Empty response");
        return text.trim();
    }finally{clearTimeout(timer)}
}

async function requestJson(url){
    const text=await requestText(url);
    try{return JSON.parse(text)}catch(e){throw new Error("Invalid JSON response")}
}

function setButton(id,active,activeClass){
    const b=el(id);
    b.className="control-button api-control";
    if(active)b.classList.add("active",activeClass);
}

function equipmentInfo(value){
    const v=String(value||"IDLE").toUpperCase();
    if(v.includes("HEAT"))return{title:"Heating",detail:"Heat running",dot:"heat",banner:"Heating",bannerClass:"heating"};
    if(v.includes("COOL"))return{title:"Cooling",detail:"Cooling running",dot:"cool",banner:"Cooling",bannerClass:"cooling"};
    return{title:"Idle",detail:"System ready",dot:"",banner:"System Normal",bannerClass:"normal"};
}

function displayThermostat(data){
    el("temperature").textContent=num(data.temperature,1);
    el("humidity").textContent=num(data.humidity,0)+"%";
    el("setpoint").textContent=num(data.setpoint,1)+"°";

    const mode=String(data.mode||"--").toUpperCase();
    const fan=String(data.fan||"--").toUpperCase();

    el("heroMode").textContent=mode;
    el("modeValue").textContent=mode;
    el("fanValue").textContent=fan;
    el("downstairsTemperature").textContent=num(data.downstairsTemp,1)+"°F";
    el("upstairsTemperature").textContent=num(data.upstairsTemp,1)+"°F";
    el("activeSensor").textContent=data.activeSensor?"Sensor "+data.activeSensor:"--";

    setButton("modeHeat",mode==="HEAT","heat");
    setButton("modeCool",mode==="COOL","cool");
    setButton("modeOff",mode==="OFF","off");
    setButton("fanAuto",fan==="AUTO","fan");
    setButton("fanOn",fan==="ON","fan");

    const eq=equipmentInfo(data.equipment);
    el("equipmentValue").textContent=eq.title;
    el("equipmentDetail").textContent=eq.detail;
    el("equipmentDot").className="equipment-dot "+eq.dot;
    el("systemBannerText").textContent=eq.banner;
    el("systemBanner").className="system-banner "+eq.bannerClass;
    el("diagnosticSensor1").textContent=data.sensor1Error?"Error":"OK";
    el("diagnosticSensor2").textContent=data.sensor2Error?"Error":"OK";
}

async function refreshStatus(force=false){
    if(refreshInProgress||(!force&&commandInProgress))return;
    refreshInProgress=true;
    try{
        const data=await requestJson(STATUS_URL);
        consecutiveFailures=0;
        lastSuccessfulUpdate=Date.now();
        displayThermostat(data);
        setConnectionState(true,false);
        const now=new Date().toLocaleTimeString();
        el("lastUpdated").textContent="Updated "+now;
        el("diagnosticUpdated").textContent=now;
        el("footerError").textContent="";
        if(el("commandMessage").textContent.includes("unlock"))showMessage("BANDYSTAT is online and ready.");
    }catch(error){
        consecutiveFailures++;
        const seconds=lastSuccessfulUpdate?(Date.now()-lastSuccessfulUpdate)/1000:999;
        const offline=consecutiveFailures>=3&&seconds>=20;
        setConnectionState(false,offline);
        el("lastUpdated").textContent=offline?"Thermostat connection lost":"Waiting for next update";
        el("footerError").textContent=error.name==="AbortError"?"Slow controller response":error.message;
        if(offline)showMessage("Reconnecting to BANDYSTAT…");
    }finally{refreshInProgress=false}
}

async function sendCommand(command){
    if(!controllerOnline||commandInProgress)return;
    commandInProgress=true;
    setControls();
    showMessage("Sending command…");
    try{
        const result=await requestJson(COMMAND_BASE_URL+command);
        if(result.success===false)throw new Error(result.error||"Command rejected");
        showMessage(result.message||"Command accepted","success");
        await new Promise(r=>setTimeout(r,250));
        await refreshStatus(true);
    }catch(error){
        showMessage(error.name==="AbortError"?"Command timed out":"Command failed: "+error.message,"error");
    }finally{
        commandInProgress=false;
        setControls();
        setTimeout(()=>refreshStatus(true),300);
    }
}

function findValue(text,patterns){
    for(const p of patterns){
        const m=text.match(p);
        if(m&&m[1]!==undefined)return m[1].trim();
    }
    return null;
}

function parsePressure(text) {

    const temp = document.createElement("div");
    temp.innerHTML = text;

    const lines = temp.innerText
        .split("\n")
        .map(x => x.trim())
        .filter(x => x.length);

    function findAfter(label) {
        const index = lines.findIndex(
            x => x.toLowerCase() === label.toLowerCase()
        );

        if (index >= 0 && index + 1 < lines.length) {
            return lines[index + 1];
        }

        return "--";
    }

    return {
        pressure: Number(
            findAfter("Pressure").replace("Pa","")
        ),

        state: findAfter("Status"),

        fan: findAfter("Fan"),

        requestedFan: findAfter("Requested"),

        starts: Number(findAfter("Starts")),

        temperature: Number(
            findAfter("Temperature").replace("F","")
        ),

        humidity: Number(
            findAfter("Humidity").replace("%","")
        ),

        runtime: findAfter("Runtime")
    };
}
function pressureStyle(state){
    const s=String(state||"--").trim().toUpperCase();
    if(s.includes("NEGATIVE")||s.includes("ALERT")||s.includes("FAULT"))return{cls:"alert",name:s.replaceAll("_"," ")};
    if(s.includes("PRESSUR")||s.includes("RUN"))return{cls:"pressurizing",name:s.replaceAll("_"," ")};
    if(s.includes("NORMAL")||s.includes("IDLE"))return{cls:"normal",name:s.replaceAll("_"," ")};
    return{cls:"normal",name:s.replaceAll("_"," ")};
}

function runtime(sec){
    const s=Number(sec);
    if(!Number.isFinite(s)||s<0)return"--";
    const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),r=Math.floor(s%60);
    if(h)return h+"h "+String(m).padStart(2,"0")+"m";
    if(m)return m+"m "+String(r).padStart(2,"0")+"s";
    return r+"s";
}

function direction(p){
    if(!Number.isFinite(p))return"Pressure reading unavailable";
    if(p<-.05)return"House is negative";
    if(p>.05)return"House is positive";
    return"House pressure is near neutral";
}

function addEvent(message,cls){
    pressureEvents.unshift({time:new Date().toLocaleTimeString(),message,cls});
    pressureEvents=pressureEvents.slice(0,30);
    renderEvents();
}

function renderEvents(){
    const box=el("pressureEventLog");
    if(!pressureEvents.length){
        box.innerHTML='<div class="information-note">No pressure events recorded.</div>';
        return;
    }
    box.innerHTML=pressureEvents.map(e=>
        '<div class="event-entry '+e.cls+'"><span class="event-time">'+e.time+
        '</span><span>'+escapeHtml(e.message)+'</span></div>'
    ).join("");
}

function escapeHtml(v){
    return String(v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}

function displayPressure(d){
    const p=Number(d.pressure);
    const style=pressureStyle(d.state);

    el("pressureValue").textContent=num(p,2);
    el("pressureDirection").textContent=direction(p);
    el("pressureState").textContent=style.name;
    el("pressureFan").textContent=d.fan||"--";
    el("pressureRequestedFan").textContent=d.requestedFan||"--";
    el("pressureRuntime").textContent=d.runtime;
    el("pressureStarts").textContent=Number.isFinite(d.starts)?String(d.starts):"--";
    el("pressureTemperature").textContent=Number.isFinite(d.temperature)?num(d.temperature,1)+"°F":"--.-°F";
    el("pressureHumidity").textContent=Number.isFinite(d.humidity)?num(d.humidity,1)+"%":"--.-%";
    el("pressureBannerText").textContent="Pressure controller "+style.name.toLowerCase();
    el("pressureBanner").className="pressure-banner "+style.cls;
    el("pressureConnectionText").textContent="Updated "+new Date().toLocaleTimeString();
    el("diagnosticPressureController").textContent="Online";

    const limited=Math.max(-2,Math.min(2,p));
    const pct=((limited+2)/4)*100;
    el("pressureGaugeNeedle").style.left=pct+"%";
    el("pressureGaugeLabel").textContent=num(p,2)+" Pa";

    const signature=[num(p,2),style.name,d.fan,d.requestedFan].join("|");
    if(!lastPressureSignature){
        addEvent("Connected: "+style.name+", pressure "+num(p,2)+" Pa",style.cls);
    }else if(lastPressureState!==style.name){
        addEvent("State changed to "+style.name+" at "+num(p,2)+" Pa",style.cls);
    }else if(signature!==lastPressureSignature){
        addEvent("Pressure "+num(p,2)+" Pa, fan "+(d.fan||"--")+", request "+(d.requestedFan||"--"),style.cls);
    }
    lastPressureState=style.name;
    lastPressureSignature=signature;
}

async function refreshPressure(){
    if(pressureRefreshInProgress)return;
    pressureRefreshInProgress=true;
    try{
        const text=await requestText(PRESSURE_STATUS_URL);
        const d=parsePressure(text);
        if(!Number.isFinite(d.pressure))throw new Error("Pressure value missing");
        displayPressure(d);
    }catch(error){
        el("pressureBanner").className="pressure-banner offline";
        el("pressureBannerText").textContent="Pressure controller unavailable";
        el("pressureConnectionText").textContent="Offline";
        el("diagnosticPressureController").textContent="Offline";
    }finally{pressureRefreshInProgress=false}
}

controls.forEach(button=>button.addEventListener("click",()=>sendCommand(button.dataset.command)));

document.querySelectorAll(".navigation-button").forEach(button=>{
    button.addEventListener("click",()=>{
        const page=button.dataset.page;
        document.querySelectorAll(".navigation-button").forEach(b=>b.classList.toggle("active",b===button));
        document.querySelectorAll(".page").forEach(p=>p.classList.toggle("active",p.id==="page-"+page));
        if(page==="pressure")refreshPressure();
    });
});

el("clearPressureLog").addEventListener("click",()=>{
    pressureEvents=[];
    renderEvents();
});

setConnectionState(false,true);
refreshStatus(true);
refreshPressure();
setInterval(()=>refreshStatus(false),REFRESH_INTERVAL_MS);
setInterval(refreshPressure,REFRESH_INTERVAL_MS);

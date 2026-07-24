(() => {
  "use strict";

  const $ = id => document.getElementById(id);

  const state = {
    leaflet:null,
    boundaryLayer:null,
    gridLayer:null,
    selectedLayer:null,
    selectedPoint:null,
    graceCube:null,
    modelCube:null,
    spatialCube:null,
    overlapDates:[],
    overlapDateSet:new Set(),
    spatialDateIndices:[],
    cubeCache:new Map(),
    loadPromises:new Map(),
    updateToken:0
  };

  const plotConfig = {
    responsive:true,
    displaylogo:false,
    modeBarButtonsToRemove:["lasso2d","select2d"],
    toImageButtonOptions:{format:"png",scale:4}
  };

  // Reversed version of the earlier multicolour scale.
  const spatialColors = [
    [0.00,"#7a0403"],
    [0.10,"#e84b1c"],
    [0.20,"#f5962d"],
    [0.30,"#f3c63a"],
    [0.40,"#c8e020"],
    [0.50,"#72e06a"],
    [0.60,"#1bcfd4"],
    [0.70,"#39a2fc"],
    [0.80,"#4675ed"],
    [0.90,"#4145ab"],
    [1.00,"#30123b"]
  ];

  function addOption(select,value,label) {
    const option=document.createElement("option");
    option.value=value;
    option.textContent=label;
    select.appendChild(option);
  }

  function init() {
    DSS_META.regions.forEach(item=>addOption($("regionSelect"),item.key,item.label));

    Object.entries(DSS_META.grace).forEach(([key,item])=>{
      addOption($("graceSelect"),key,item.label);
    });

    DSS_META.products.forEach(item=>addOption($("productSelect"),item.key,item.label));
    (DSS_META.bestProducts || []).forEach(item=>
      addOption($("bestProductSelect"),item.key,item.label)
    );
    DSS_META.datasetModes.forEach(item=>addOption($("modeSelect"),item.key,item.label));

    $("analysisModeSelect").value="shapefile";
    $("regionSelect").value =
      DSS_META.regions.find(item=>item.label==="Thailand")?.key || DSS_META.regions[0].key;
    $("graceSelect").value="csr";
    $("productSelect").value =
      DSS_META.products.find(item=>item.key==="imerg")?.key || DSS_META.products[0].key;
    $("modeSelect").value="resampled";

    createLeafletMap();
    enforceDatasetAvailability();
    refreshProductOptions();

    $("analysisModeSelect").addEventListener("change",()=>{
      state.selectedPoint=null;
      updateDashboard();
    });

    $("regionSelect").addEventListener("change",()=>{
      state.selectedPoint=null;
      updateDashboard();
    });

    $("graceSelect").addEventListener("change",()=>{
      state.selectedPoint=null;
      enforceDatasetAvailability();
      refreshProductOptions();
      updateDashboard();
    });

    $("modeSelect").addEventListener("change",()=>{
      enforceDatasetAvailability();
      refreshProductOptions();
      updateDashboard();
    });

    $("productSelect").addEventListener("change",()=>{
      $("bestProductSelect").value="";
      updateDashboard();
    });

    $("bestProductSelect").addEventListener("change",()=>{
      enforceDatasetAvailability();
      updateDashboard();
    });

    $("mapLayerSelect").addEventListener("change",updateDashboard);

    $("monthSlider").addEventListener("input",()=>{
      syncDateSelectorsFromSlider();
      renderSpatial();
    });

    $("showSelectedMonthButton").addEventListener("click",showSpecificSpatialMonth);
    updateDashboard();
  }

  function current() {
    return {
      analysis:$("analysisModeSelect").value,
      region:$("regionSelect").value,
      grace:$("graceSelect").value,
      standardProduct:$("productSelect").value,
      bestProduct:$("bestProductSelect").value,
      product:$("bestProductSelect").value || $("productSelect").value,
      mode:$("modeSelect").value,
      layer:$("mapLayerSelect").value
    };
  }

  function regionMeta() {
    return DSS_META.regions.find(item=>item.key===current().region);
  }

  function isGraceOnlyRegion() {
    return Boolean(regionMeta()?.graceOnly);
  }

  function selectedProductMeta() {
    const key=current().product;
    return (
      DSS_META.products.find(item=>item.key===key) ||
      (DSS_META.bestProducts || []).find(item=>item.key===key) ||
      {}
    );
  }

  function isBestTwsaProduct() {
    return selectedProductMeta().kind==="best_twsa";
  }

  function isStandaloneSelection() {
    return isGraceOnlyRegion();
  }

  function labelRegion(key) {
    return DSS_META.regions.find(item=>item.key===key)?.label || key;
  }

  function labelProduct(key) {
    return (
      DSS_META.products.find(item=>item.key===key)?.label ||
      (DSS_META.bestProducts || []).find(item=>item.key===key)?.label ||
      key
    );
  }

  function fmt(value,digits=3) {
    return value===null || value===undefined || !Number.isFinite(Number(value))
      ? "NA"
      : Number(value).toFixed(digits);
  }

  function resampledProductsForGrace(graceKey) {
    return (DSS_META.resampledAvailability || {})[graceKey] || [];
  }

  function enforceDatasetAvailability() {
    const graceKey=$("graceSelect").value;
    const bestSelected=Boolean($("bestProductSelect").value);
    const available=!bestSelected && resampledProductsForGrace(graceKey).length>0;
    const resampledOption=[...$("modeSelect").options]
      .find(item=>item.value==="resampled");

    if (resampledOption) resampledOption.disabled=!available;

    if (bestSelected || (!available && $("modeSelect").value==="resampled")) {
      $("modeSelect").value="raw";
    }

    $("productSelect").disabled=bestSelected || isGraceOnlyRegion();
    $("modeSelect").disabled=bestSelected || isGraceOnlyRegion();
  }

  function refreshProductOptions() {
    const graceKey=$("graceSelect").value;
    const mode=$("modeSelect").value;
    const previous=$("productSelect").value;

    const allowed=mode==="resampled"
      ? resampledProductsForGrace(graceKey)
      : DSS_META.products.map(item=>item.key);

    $("productSelect").innerHTML="";

    DSS_META.products
      .filter(item=>allowed.includes(item.key))
      .forEach(item=>addOption($("productSelect"),item.key,item.label));

    const values=[...$("productSelect").options].map(item=>item.value);

    if (values.includes(previous)) $("productSelect").value=previous;
    else if (values.includes("imerg")) $("productSelect").value="imerg";
    else if (values.length) $("productSelect").value=values[0];

    enforceDatasetAvailability();
  }

  function selectedRegionBlock() {
    const s=current();
    return DSS_SERIES[s.region][s.grace];
  }

  function mapEntry({mode,product=null}) {
    const s=current();

    if (mode==="grace") {
      return DSS_META.mapManifest.find(item=>
        item.region===s.region &&
        item.grace===s.grace &&
        item.mode==="grace"
      );
    }

    return DSS_META.mapManifest.find(item=>
      item.region===s.region &&
      item.mode===mode &&
      item.product===product &&
      (mode!=="resampled" || item.grace===s.grace)
    );
  }

  function loadCube(entry) {
    if (!entry) return Promise.reject(new Error("Required spatial data file was not found."));

    if (state.cubeCache.has(entry.variable)) {
      return Promise.resolve(state.cubeCache.get(entry.variable));
    }

    if (state.loadPromises.has(entry.variable)) {
      return state.loadPromises.get(entry.variable);
    }

    const promise=new Promise((resolve,reject)=>{
      const script=document.createElement("script");
      script.src=entry.file;
      script.async=true;

      script.onload=()=>{
        const cube=window[entry.variable];
        if (!cube) {
          reject(new Error(`Loaded ${entry.file}, but ${entry.variable} was not defined.`));
          return;
        }

        state.cubeCache.set(entry.variable,cube);
        script.remove();
        resolve(cube);
      };

      script.onerror=()=>{
        script.remove();
        reject(new Error(`Unable to load ${entry.file}`));
      };

      document.body.appendChild(script);
    }).finally(()=>{
      state.loadPromises.delete(entry.variable);
    });

    state.loadPromises.set(entry.variable,promise);
    return promise;
  }

  function baseLayout(yTitle) {
    return {
      paper_bgcolor:"rgba(0,0,0,0)",
      plot_bgcolor:"#fff",
      font:{family:"Arial,Helvetica,sans-serif",color:"#334155",size:12},
      margin:{l:66,r:25,t:28,b:55},
      hovermode:"x unified",
      xaxis:{
        title:"Date",
        gridcolor:"#e5ebf2",
        linecolor:"#b7c4d4",
        tickformat:"%Y",
        dtick:"M24",
        zeroline:false
      },
      yaxis:{
        title:yTitle,
        gridcolor:"#e5ebf2",
        linecolor:"#b7c4d4",
        zeroline:true,
        zerolinecolor:"#66758a",
        zerolinewidth:1
      },
      legend:{
        orientation:"h",
        x:0,
        y:1.10,
        bgcolor:"rgba(255,255,255,.84)"
      }
    };
  }

  function cubeValue(cube,t,i,j) {
    const nLon=cube.shape[2];
    const nCell=cube.shape[1]*nLon;
    const q=cube.values[t*nCell+i*nLon+j];
    return q===cube.missing ? null : q*cube.scale;
  }

  function cubeSeries(cube,i,j) {
    const values=[];
    for (let t=0;t<cube.shape[0];t++) values.push(cubeValue(cube,t,i,j));
    return {dates:cube.dates,values};
  }

  function cellEdges(values) {
    const v=values.map(Number);
    if (v.length===1) return [v[0]-.5,v[0]+.5];

    const edges=[v[0]-(v[1]-v[0])/2];
    for (let i=0;i<v.length-1;i++) edges.push((v[i]+v[i+1])/2);
    edges.push(v[v.length-1]+(v[v.length-1]-v[v.length-2])/2);
    return edges;
  }

  function graceCellBounds(cube,i,j) {
    const latEdges=cellEdges(cube.lat);
    const lonEdges=cellEdges(cube.lon);

    return {
      south:Math.min(latEdges[i],latEdges[i+1]),
      north:Math.max(latEdges[i],latEdges[i+1]),
      west:Math.min(lonEdges[j],lonEdges[j+1]),
      east:Math.max(lonEdges[j],lonEdges[j+1])
    };
  }

  function nearestIndex(values,target) {
    let best=0;
    let distance=Infinity;

    values.forEach((value,index)=>{
      const d=Math.abs(Number(value)-Number(target));
      if (d<distance) {
        distance=d;
        best=index;
      }
    });

    return best;
  }

  function modelPointSeries(modelCube,graceCube,selectedPoint,mode) {
    if (mode==="resampled") {
      const i=nearestIndex(modelCube.lat,selectedPoint.lat);
      const j=nearestIndex(modelCube.lon,selectedPoint.lon);
      return {
        ...cubeSeries(modelCube,i,j),
        method:"Nearest corresponding cell on the selected GRACE-resampled grid",
        nCells:1
      };
    }

    const bounds=graceCellBounds(graceCube,selectedPoint.i,selectedPoint.j);
    const latIndices=[];
    const lonIndices=[];

    modelCube.lat.forEach((lat,index)=>{
      if (Number(lat)>=bounds.south && Number(lat)<=bounds.north) latIndices.push(index);
    });

    modelCube.lon.forEach((lon,index)=>{
      if (Number(lon)>=bounds.west && Number(lon)<=bounds.east) lonIndices.push(index);
    });

    if (!latIndices.length || !lonIndices.length) {
      const i=nearestIndex(modelCube.lat,selectedPoint.lat);
      const j=nearestIndex(modelCube.lon,selectedPoint.lon);
      return {
        ...cubeSeries(modelCube,i,j),
        method:"Nearest original-grid PCR-GLOBWB cell",
        nCells:1
      };
    }

    const values=[];

    for (let t=0;t<modelCube.shape[0];t++) {
      let total=0;
      let count=0;

      latIndices.forEach(i=>{
        lonIndices.forEach(j=>{
          const value=cubeValue(modelCube,t,i,j);
          if (value!==null && Number.isFinite(value)) {
            total+=value;
            count+=1;
          }
        });
      });

      values.push(count ? total/count : null);
    }

    return {
      dates:modelCube.dates,
      values,
      method:"Original-grid PCR-GLOBWB cells averaged inside the selected GRACE grid cell",
      nCells:latIndices.length*lonIndices.length
    };
  }

  function commonPairs(graceSeries,modelSeries) {
    const modelMap=new Map(
      modelSeries.dates.map((date,index)=>[date,modelSeries.values[index]])
    );

    const g=[];
    const m=[];

    graceSeries.dates.forEach((date,index)=>{
      const gv=graceSeries.values[index];
      const mv=modelMap.get(date);

      if (gv!==null && mv!==null &&
          Number.isFinite(Number(gv)) && Number.isFinite(Number(mv))) {
        g.push(Number(gv));
        m.push(Number(mv));
      }
    });

    if (!g.length) return {g,m};

    const meanG=g.reduce((a,b)=>a+b,0)/g.length;
    const meanM=m.reduce((a,b)=>a+b,0)/m.length;

    return {
      g:g.map(value=>value-meanG),
      m:m.map(value=>value-meanM)
    };
  }

  function calculateMetrics(graceSeries,modelSeries) {
    const {g,m}=commonPairs(graceSeries,modelSeries);
    const n=g.length;

    if (n<2) return {n,corr:null,nse:null,rmse:null};

    const meanG=g.reduce((a,b)=>a+b,0)/n;
    const meanM=m.reduce((a,b)=>a+b,0)/n;

    let covariance=0;
    let varianceG=0;
    let varianceM=0;
    let squaredError=0;

    for (let i=0;i<n;i++) {
      covariance+=(g[i]-meanG)*(m[i]-meanM);
      varianceG+=(g[i]-meanG)**2;
      varianceM+=(m[i]-meanM)**2;
      squaredError+=(m[i]-g[i])**2;
    }

    const corr=varianceG>0 && varianceM>0
      ? covariance/Math.sqrt(varianceG*varianceM)
      : null;

    return {
      n,
      corr,
      nse:varianceG>0 ? 1-squaredError/varianceG : null,
      rmse:Math.sqrt(squaredError/n)
    };
  }

  function trend(series) {
    const valid=[];

    series.values.forEach((value,index)=>{
      if (value!==null && Number.isFinite(Number(value))) {
        valid.push({date:series.dates[index],value:Number(value)});
      }
    });

    if (valid.length<3) return null;

    const start=new Date(valid[0].date+"-01");
    const x=valid.map(item=>(new Date(item.date+"-01")-start)/(365.2425*86400000));
    const y=valid.map(item=>item.value);
    const meanX=x.reduce((a,b)=>a+b,0)/x.length;
    const meanY=y.reduce((a,b)=>a+b,0)/y.length;

    let numerator=0;
    let denominator=0;

    x.forEach((value,index)=>{
      numerator+=(value-meanX)*(y[index]-meanY);
      denominator+=(value-meanX)**2;
    });

    const slope=denominator ? numerator/denominator : null;
    if (slope===null) return null;

    const intercept=meanY-slope*meanX;

    return {
      slope,
      dates:valid.map(item=>item.date),
      values:x.map(value=>intercept+slope*value)
    };
  }

  function dateIntersection(firstDates,secondDates) {
    const second=new Set(secondDates || []);
    return (firstDates || []).filter(date=>second.has(date));
  }

  function restrictSeriesToOverlap(series) {
    if (!series || !state.overlapDateSet.size) return series;

    const dates=[];
    const values=[];

    series.dates.forEach((date,index)=>{
      if (state.overlapDateSet.has(date)) {
        dates.push(date);
        values.push(series.values[index]);
      }
    });

    return {
      ...series,
      dates,
      values
    };
  }

  function overlapPeriodLabel() {
    if (!state.overlapDates.length) return "No overlapping months";

    return `${state.overlapDates[0]} to ` +
      `${state.overlapDates[state.overlapDates.length-1]}`;
  }

  function activeGraceSeries() {
    const s=current();
    let series;

    if (s.analysis==="point" && state.selectedPoint && state.graceCube) {
      series=cubeSeries(state.graceCube,state.selectedPoint.i,state.selectedPoint.j);
    } else {
      series=selectedRegionBlock().grace;
    }

    return restrictSeriesToOverlap(series);
  }

  async function activeModelSeries(product=current().product) {
    const s=current();
    if (isStandaloneSelection()) return null;

    let series;

    if (s.analysis==="shapefile") {
      series=selectedRegionBlock()[s.mode][product]?.series || null;
    } else {
      if (!state.selectedPoint || !state.graceCube) return null;

      const entry=mapEntry({mode:s.mode,product});
      if (!entry) return null;

      const cube=await loadCube(entry);
      series=modelPointSeries(cube,state.graceCube,state.selectedPoint,s.mode);
    }

    return restrictSeriesToOverlap(series);
  }

  function analysisLabel() {
    const s=current();

    if (s.analysis==="point" && state.selectedPoint) {
      return `Selected Grid | Lat ${state.selectedPoint.lat.toFixed(3)}, Lon ${state.selectedPoint.lon.toFixed(3)}`;
    }

    if (s.analysis==="point") return "Point Selection — no grid selected";
    return "Country Average";
  }

  function renderGraceOnly() {
    const s=current();
    const series=activeGraceSeries();
    const title=
      `${labelRegion(s.region)} - ${DSS_META.grace[s.grace].label} TWSA Time Series | ` +
      `${analysisLabel()}`;
    $("graceTitle").textContent=title;

    const traces=[{
      x:series.dates,
      y:series.values,
      type:"scatter",
      mode:"lines+markers",
      name:DSS_META.grace[s.grace].label,
      line:{color:"#2563eb",width:2.2},
      marker:{size:4,color:"#2563eb"},
      connectgaps:false
    }];

    const fit=trend(series);

    if (fit) {
      traces.push({
        x:fit.dates,
        y:fit.values,
        type:"scatter",
        mode:"lines",
        name:`Linear trend ${fit.slope>=0?"+":""}${fmt(fit.slope)} cm/year`,
        line:{color:"#e11d48",width:2.5,dash:"dash"},
        connectgaps:false
      });
    }

    Plotly.react("graceOnlyPlot",traces,baseLayout("GRACE TWSA (cm)"),plotConfig);
  }

  async function renderComparison() {
    if (isStandaloneSelection()) return;

    const s=current();
    const graceSeries=activeGraceSeries();
    const modelSeries=await activeModelSeries();

    const product=labelProduct(s.product);
    const title=
      `${labelRegion(s.region)} - ${DSS_META.grace[s.grace].label} versus PCR-GLOBWB (${product}) | ` +
      `${analysisLabel()}`;

    $("comparisonTitle").textContent=title;

    if (!modelSeries || (s.analysis==="point" && !state.selectedPoint)) {
      Plotly.react("comparisonPlot",[],{
        ...baseLayout("TWS anomaly (cm)"),
        annotations:[{
          text:"Select a GRACE grid centre on the map to display the point comparison.",
          x:.5,y:.5,xref:"paper",yref:"paper",showarrow:false
        }]
      },plotConfig);
      return;
    }

    Plotly.react("comparisonPlot",[
      {
        x:graceSeries.dates,
        y:graceSeries.values,
        type:"scatter",
        mode:"lines",
        name:DSS_META.grace[s.grace].label,
        line:{color:"#2563eb",width:2.4},
        connectgaps:false
      },
      {
        x:modelSeries.dates,
        y:modelSeries.values,
        type:"scatter",
        mode:"lines",
        name:`PCR-GLOBWB ${product} — ${s.mode}`,
        line:{color:"#ef4444",width:2.3},
        connectgaps:false
      }
    ],baseLayout("TWS anomaly (cm)"),plotConfig);
  }

  async function renderPerformanceMetrics() {
    if (isStandaloneSelection()) return;

    const s=current();
    const graceSeries=activeGraceSeries();
    const modelSeries=await activeModelSeries();

    const metrics=modelSeries
      ? calculateMetrics(graceSeries,modelSeries)
      : {corr:null,nse:null,rmse:null};

    Plotly.react("skillMetricsPlot",[{
      x:["Correlation","NSE"],
      y:[metrics.corr,metrics.nse],
      type:"bar",
      marker:{color:["#2563eb","#0ea5e9"]},
      text:[fmt(metrics.corr),fmt(metrics.nse)],
      textposition:"outside",
      cliponaxis:false
    }],{
      title:{text:"Skill Metrics for the Selected Precipitation Product",font:{size:14,color:"#183153"}},
      paper_bgcolor:"rgba(0,0,0,0)",
      plot_bgcolor:"#fff",
      font:{family:"Arial,Helvetica,sans-serif",color:"#334155"},
      margin:{l:55,r:20,t:55,b:48},
      xaxis:{linecolor:"#b7c4d4"},
      yaxis:{title:"Metric value",gridcolor:"#e5ebf2",zeroline:true}
    },plotConfig);

    Plotly.react("errorMetricPlot",[{
      x:["RMSE"],
      y:[metrics.rmse],
      type:"bar",
      marker:{color:"#f59e0b"},
      text:[metrics.rmse===null ? "NA" : `${fmt(metrics.rmse)} cm`],
      textposition:"outside",
      cliponaxis:false,
      width:[.42]
    }],{
      title:{text:"Error Metrics for the Selected Precipitation Product",font:{size:14,color:"#183153"}},
      paper_bgcolor:"rgba(0,0,0,0)",
      plot_bgcolor:"#fff",
      font:{family:"Arial,Helvetica,sans-serif",color:"#334155"},
      margin:{l:55,r:20,t:55,b:48},
      xaxis:{linecolor:"#b7c4d4"},
      yaxis:{title:"RMSE (cm)",gridcolor:"#e5ebf2",zeroline:true}
    },plotConfig);
  }

  async function renderCards() {
    const s=current();
    const graceSeries=activeGraceSeries();
    const graceTrend=trend(graceSeries);

    if (isStandaloneSelection()) {
      const cards=[
        ["Study Region",labelRegion(s.region)],
        ["Analysis Mode",analysisLabel()],
        ["GRACE Product",DSS_META.grace[s.grace].label],
        ["GRACE Trend",graceTrend ? `${fmt(graceTrend.slope)} cm/year` : "NA"]
      ];

      $("summaryCards").innerHTML=cardHtml(cards);
      return;
    }

    const modelSeries=await activeModelSeries();
    const modelTrend=modelSeries ? trend(modelSeries) : null;
    const metrics=modelSeries
      ? calculateMetrics(graceSeries,modelSeries)
      : {corr:null,nse:null,rmse:null};

    const cards=[
      ["Study Region",labelRegion(s.region)],
      ["Analysis Mode",analysisLabel()],
      [isBestTwsaProduct() ? "Best PCR Product" : "PCR Product",labelProduct(s.product)],
      ["GRACE Trend",graceTrend ? `${fmt(graceTrend.slope)} cm/year` : "NA"],
      ["PCR-GLOBWB Trend",modelTrend ? `${fmt(modelTrend.slope)} cm/year` : "NA"],
      ["Correlation",fmt(metrics.corr)]
    ];

    $("summaryCards").innerHTML=cardHtml(cards);

    if (modelTrend && s.analysis==="point" && state.selectedPoint) {
      $("pointInfo").textContent +=
        ` | PCR trend: ${fmt(modelTrend.slope)} cm/year`;
    }
  }

  function cardHtml(cards) {
    return cards.map(([label,value])=>
      `<div class="summary-card"><div class="label">${label}</div><div class="value">${value}</div></div>`
    ).join("");
  }

  function createLeafletMap() {
    state.leaflet=L.map("leafletMap",{
      zoomControl:true,
      preferCanvas:true
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{
      maxZoom:18,
      attribution:"&copy; OpenStreetMap contributors"
    }).addTo(state.leaflet);

    L.control.scale({imperial:false,position:"bottomleft"}).addTo(state.leaflet);

    state.leaflet.on("click",event=>{
      if (current().analysis!=="point" || !state.graceCube) return;
      selectNearestPoint(event.latlng.lat,event.latlng.lng);
    });
  }

  function updateBoundary() {
    const s=current();
    const meta=regionMeta();
    const geometry=DSS_BOUNDARIES[s.region];

    if (state.boundaryLayer) state.leaflet.removeLayer(state.boundaryLayer);

    state.boundaryLayer=L.geoJSON(
      {type:"Feature",properties:{name:meta.label},geometry},
      {
        style:{
          color:"#111827",
          weight:3,
          opacity:1,
          fillColor:"#38bdf8",
          fillOpacity:.22
        }
      }
    ).addTo(state.leaflet);

    const bounds=meta.bounds;
    state.leaflet.fitBounds(
      [[bounds[1],bounds[0]],[bounds[3],bounds[2]]],
      {padding:[18,18]}
    );
  }

  function validGraceCells(cube) {
    const cells=[];
    const nLat=cube.shape[1];
    const nLon=cube.shape[2];

    for (let i=0;i<nLat;i++) {
      for (let j=0;j<nLon;j++) {
        let valid=false;

        for (let t=0;t<cube.shape[0];t++) {
          if (cubeValue(cube,t,i,j)!==null) {
            valid=true;
            break;
          }
        }

        if (valid) {
          cells.push({
            i,j,
            lat:Number(cube.lat[i]),
            lon:Number(cube.lon[j])
          });
        }
      }
    }

    return cells;
  }

  function updateGridMarkers() {
    if (state.gridLayer) {
      state.leaflet.removeLayer(state.gridLayer);
      state.gridLayer=null;
    }

    if (state.selectedLayer) {
      state.leaflet.removeLayer(state.selectedLayer);
      state.selectedLayer=null;
    }

    const s=current();

    if (s.analysis!=="point" || !state.graceCube) {
      $("mapInstruction").textContent =
        "OpenStreetMap background with selected shapefile boundary";
      $("pointInfo").textContent =
        "Shapefile mode: time series and metrics represent the regional average.";
      return;
    }

    $("mapInstruction").textContent =
      "Select a blue GRACE grid centre. Map clicks snap to the nearest valid GRACE cell.";

    const renderer=L.canvas({padding:.5});
    const group=L.layerGroup();
    const cells=validGraceCells(state.graceCube);

    cells.forEach(cell=>{
      L.circleMarker([cell.lat,cell.lon],{
        renderer,
        radius:4.2,
        color:"#111827",
        weight:1.1,
        fillColor:"#2563eb",
        fillOpacity:.95,
        className:"grace-grid-marker"
      })
      .bindTooltip(
        `GRACE grid centre<br>` +
        `Lat ${cell.lat.toFixed(3)}, Lon ${cell.lon.toFixed(3)}`
      )
      .on("click",event=>{
        if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
        selectPoint(cell);
      })
      .addTo(group);
    });

    group.addTo(state.leaflet);
    state.gridLayer=group;

    if (state.selectedPoint) highlightSelectedPoint();
    else $("pointInfo").textContent="Point mode active. No GRACE grid has been selected.";
  }

  function selectNearestPoint(lat,lon) {
    const cells=validGraceCells(state.graceCube);
    if (!cells.length) return;

    const factor=Math.cos(lat*Math.PI/180);
    let selected=cells[0];
    let best=Infinity;

    cells.forEach(cell=>{
      const distance=(cell.lat-lat)**2+((cell.lon-lon)*factor)**2;
      if (distance<best) {
        best=distance;
        selected=cell;
      }
    });

    selectPoint(selected);
  }

  function selectPoint(point) {
    state.selectedPoint={...point};
    highlightSelectedPoint();
    updatePointOutputs();
  }

  function highlightSelectedPoint() {
    if (state.selectedLayer) state.leaflet.removeLayer(state.selectedLayer);
    if (!state.selectedPoint || !state.graceCube) return;

    const point=state.selectedPoint;
    const bounds=graceCellBounds(state.graceCube,point.i,point.j);

    state.selectedLayer=L.rectangle(
      [[bounds.south,bounds.west],[bounds.north,bounds.east]],
      {
        color:"#dc2626",
        weight:3,
        fillColor:"#ef4444",
        fillOpacity:.16
      }
    ).addTo(state.leaflet);

    state.selectedLayer.bringToFront();

    $("pointInfo").textContent =
      `Selected GRACE grid centre: Lat ${point.lat.toFixed(4)}, Lon ${point.lon.toFixed(4)}`;
  }

  async function updatePointOutputs() {
    const token=++state.updateToken;
    $("loadingOverlay").style.display="flex";

    try {
      renderSpatial();
      renderGraceOnly();
      await renderComparison();
      await renderPerformanceMetrics();
      await renderCards();
    } catch (error) {
      console.error(error);
      alert(error.message);
    } finally {
      if (token===state.updateToken) $("loadingOverlay").style.display="none";
    }
  }

  function populateSpatialYearOptions() {
    const dates=state.overlapDates;
    if (!dates.length) return;

    const years=[...new Set(dates.map(date=>date.slice(0,4)))];
    const previous=$("spatialYearSelect").value;

    $("spatialYearSelect").innerHTML="";
    years.forEach(year=>addOption($("spatialYearSelect"),year,year));

    if (years.includes(previous)) $("spatialYearSelect").value=previous;
    else if (years.length) $("spatialYearSelect").value=years[0];

    syncDateSelectorsFromSlider();
  }

  function syncDateSelectorsFromSlider() {
    const dates=state.overlapDates;
    if (!dates.length) return;

    const index=Math.max(
      0,
      Math.min(Number($("monthSlider").value),dates.length-1)
    );

    const [year,month]=dates[index].split("-");

    if ([...$("spatialYearSelect").options].some(option=>option.value===year)) {
      $("spatialYearSelect").value=year;
    }

    $("spatialMonthSelect").value=month;
  }

  function showSpecificSpatialMonth() {
    const dates=state.overlapDates;
    if (!dates.length) return;

    const requested=
      `${$("spatialYearSelect").value}-${$("spatialMonthSelect").value}`;

    const index=dates.indexOf(requested);

    if (index<0) {
      alert(
        `${requested} is outside the overlapping period of the selected GRACE and PCR datasets.`
      );
      return;
    }

    $("monthSlider").value=index;
    renderSpatial();
  }

  function percentile(sorted,p) {
    if (!sorted.length) return null;
    const position=(sorted.length-1)*p;
    const low=Math.floor(position);
    const high=Math.ceil(position);
    if (low===high) return sorted[low];
    return sorted[low]*(high-position)+sorted[high]*(position-low);
  }

  function automaticColorRange(values) {
    const finite=values
      .filter(value=>value!==null && Number.isFinite(Number(value)))
      .map(Number)
      .sort((a,b)=>a-b);

    if (!finite.length) return [-1,1];

    let low=percentile(finite,.02);
    let high=percentile(finite,.98);

    if (!Number.isFinite(low) || !Number.isFinite(high) || low===high) {
      low=Math.min(...finite);
      high=Math.max(...finite);
    }

    const limit=Math.max(Math.abs(low),Math.abs(high),.01);
    return [-limit,limit];
  }

  function boundaryTraces() {
    const geometry=DSS_BOUNDARIES[current().region];
    const traces=[];

    function addRing(ring) {
      traces.push({
        x:ring.map(point=>point[0]),
        y:ring.map(point=>point[1]),
        type:"scatter",
        mode:"lines",
        line:{color:"#000",width:2.5},
        hoverinfo:"skip",
        showlegend:false
      });
    }

    if (geometry.type==="Polygon") geometry.coordinates.forEach(addRing);
    else if (geometry.type==="MultiPolygon") {
      geometry.coordinates.forEach(polygon=>polygon.forEach(addRing));
    }

    return traces;
  }

  function renderSpatial() {
    const cube=state.spatialCube;
    if (!cube) return;

    const overlapIndex=Number($("monthSlider").value);
    const index=state.spatialDateIndices[overlapIndex];
    if (index===undefined) return;

    const displayedDate=state.overlapDates[overlapIndex];
    const nLat=cube.shape[1];
    const nLon=cube.shape[2];
    const z=[];
    const flat=[];

    for (let i=0;i<nLat;i++) {
      const row=[];
      for (let j=0;j<nLon;j++) {
        const value=cubeValue(cube,index,i,j);
        row.push(value);
        if (value!==null) flat.push(value);
      }
      z.push(row);
    }

    const zmin=-60;
    const zmax=60;
    const s=current();

    const source=s.layer==="grace" || isStandaloneSelection()
      ? DSS_META.grace[s.grace].label
      : (
          s.mode==="resampled"
            ? `PCR-GLOBWB ${labelProduct(s.product)} resampled to ${DSS_META.grace[s.grace].label} grid`
            : `PCR-GLOBWB ${labelProduct(s.product)} original-grid TWSA`
        );

    $("monthBadge").textContent =
      `${displayedDate} · overlap month ${overlapIndex+1} of ${state.overlapDates.length}`;

    $("spatialSubtitle").textContent =
      `${labelRegion(s.region)} · ${source} · ${analysisLabel()}`;

    const traces=[{
      type:"heatmap",
      x:cube.lon,
      y:cube.lat,
      z,
      zmin,zmax,zmid:0,
      colorscale:spatialColors,
      colorbar:{
        title:{text:"TWSA<br>(cm)",side:"right"},
        thickness:18,
        len:.82,
        tickformat:".1f"
      },
      hovertemplate:
        "Longitude %{x:.3f}<br>Latitude %{y:.3f}<br>TWSA %{z:.2f} cm<extra></extra>"
    },...boundaryTraces()];

    if (s.analysis==="point" && state.selectedPoint && state.graceCube) {
      const bounds=graceCellBounds(
        state.graceCube,
        state.selectedPoint.i,
        state.selectedPoint.j
      );

      traces.push({
        x:[bounds.west,bounds.east,bounds.east,bounds.west,bounds.west],
        y:[bounds.south,bounds.south,bounds.north,bounds.north,bounds.south],
        type:"scatter",
        mode:"lines",
        line:{color:"#dc2626",width:3},
        fill:"toself",
        fillcolor:"rgba(239,68,68,.12)",
        hoverinfo:"skip",
        showlegend:false
      });
    }

    Plotly.react("spatialPlot",traces,{
      title:{
        text:`${labelRegion(s.region)} - ${source} Spatial Anomaly - ${displayedDate}`,
        font:{size:15,color:"#000000"}
      },
      paper_bgcolor:"#ffffff",
      plot_bgcolor:"#fff",
      font:{family:"Arial,Helvetica,sans-serif",color:"#000000"},
      margin:{l:66,r:88,t:55,b:58},
      xaxis:{title:"Longitude",gridcolor:"#d9d9d9",zeroline:false},
      yaxis:{
        title:"Latitude",
        gridcolor:"#d9d9d9",
        zeroline:false,
        scaleanchor:"x",
        scaleratio:1
      }
    },plotConfig);
  }

  function updateAvailability() {
    const standalone=isStandaloneSelection();
    const pointMode=current().analysis==="point";
    const bestSelected=Boolean($("bestProductSelect").value);

    enforceDatasetAvailability();

    $("bestProductSelect").disabled=standalone;

    const modelOption=[...$("mapLayerSelect").options]
      .find(option=>option.value==="model");

    if (modelOption) modelOption.disabled=standalone;
    if (standalone) $("mapLayerSelect").value="grace";

    $("graceOnlyNotice").hidden=!isGraceOnlyRegion();
    $("pointModeNotice").hidden=!pointMode;
    $("comparisonPanel").hidden=standalone;
    $("performancePanel").hidden=standalone;

    if (!standalone) {
      $("productSelect").disabled=bestSelected;
      $("modeSelect").disabled=bestSelected;
    }
  }

  async function updateDashboard() {
    const token=++state.updateToken;
    $("loadingOverlay").style.display="flex";

    try {
      updateAvailability();
      refreshProductOptions();
      updateBoundary();

      const s=current();
      const graceEntry=mapEntry({mode:"grace"});
      state.graceCube=await loadCube(graceEntry);

      if (isStandaloneSelection()) {
        state.modelCube=null;
        state.overlapDates=[...state.graceCube.dates];
      } else {
        const modelEntry=mapEntry({mode:s.mode,product:s.product});
        state.modelCube=await loadCube(modelEntry);
        state.overlapDates=dateIntersection(
          state.graceCube.dates,
          state.modelCube.dates
        );
      }

      if (!state.overlapDates.length) {
        throw new Error(
          "The selected GRACE and PCR-GLOBWB datasets do not have an overlapping monthly period."
        );
      }

      state.overlapDateSet=new Set(state.overlapDates);

      const spatialEntry =
        s.layer==="grace" || isStandaloneSelection()
          ? graceEntry
          : mapEntry({mode:s.mode,product:s.product});

      state.spatialCube=
        s.layer==="grace" || isStandaloneSelection()
          ? state.graceCube
          : state.modelCube;

      if (token!==state.updateToken) return;

      const spatialDateIndex=new Map(
        state.spatialCube.dates.map((date,index)=>[date,index])
      );

      state.spatialDateIndices=state.overlapDates.map(
        date=>spatialDateIndex.get(date)
      );

      const n=state.overlapDates.length;
      $("monthSlider").max=Math.max(0,n-1);
      $("monthSlider").value=Math.min(Number($("monthSlider").value),n-1);
      $("firstMonthLabel").textContent=state.overlapDates[0] || "";
      $("lastMonthLabel").textContent=state.overlapDates[n-1] || "";
      populateSpatialYearOptions();

      updateGridMarkers();
      renderSpatial();
      renderGraceOnly();
      await renderComparison();
      await renderPerformanceMetrics();
      await renderCards();
    } catch (error) {
      console.error(error);
      alert(error.message);
    } finally {
      if (token===state.updateToken) $("loadingOverlay").style.display="none";
    }
  }

  window.addEventListener("DOMContentLoaded",init);
})();

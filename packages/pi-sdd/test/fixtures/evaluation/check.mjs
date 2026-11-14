const response=await fetch(process.env.SDD_READY_URL);
if(!response.ok||await response.text()!=='ok')process.exitCode=1;

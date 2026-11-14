let input='';for await(const chunk of process.stdin)input+=chunk;
if(process.argv.length!==2||JSON.parse(input).scenarioId!==process.env.SDD_SCENARIO_ID)process.exitCode=1;

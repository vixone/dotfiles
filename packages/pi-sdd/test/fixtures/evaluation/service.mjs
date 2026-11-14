import http from 'node:http';
const server=http.createServer((req,res)=>{res.statusCode=process.argv[3]==='unhealthy'?503:200;res.end('ok');});
server.listen(Number(process.argv[2]),'127.0.0.1',()=>console.log('SERVICE_STARTED'));
process.on('SIGTERM',()=>server.close());

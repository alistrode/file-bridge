// Maintenance adapter for the already authorized SSH Relay installation, not an application dependency.
// node scripts/call-connected-host.mjs RELAY_SOURCE NEAR_STATE MCP_STATE < private-request.json
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const [relaySource,nearState,mcpState]=process.argv.slice(2);
if(!relaySource||!nearState||!mcpState)throw Error('Provide relay source, authorized near state and MCP state directories');
const root=path.resolve(relaySource),requireRelay=createRequire(path.join(root,'package.json'));
const {Client}=await import(pathToFileURL(requireRelay.resolve('@modelcontextprotocol/sdk/client/index.js')));
const {StdioClientTransport}=await import(pathToFileURL(requireRelay.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
let input='';for await(const chunk of process.stdin)input+=chunk;const request=JSON.parse(input);
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'src/mcp.cjs'),'--agent-dir',path.resolve(nearState),'--state-dir',path.resolve(mcpState)],stderr:'inherit'});
const client=new Client({name:'file-bridge-maintenance',version:'1.0'});
try{await client.connect(transport);console.log(JSON.stringify(await client.callTool({name:request.name,arguments:request.arguments||{}},undefined,{timeout:300000})));}finally{await client.close();}

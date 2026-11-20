export function controlSpec(z, createInfo) {
  const codec = (name, schema, jsonSchema) => ({mode:'strict',typeSymbol:'@yunshu/dsh-desktop/control#'+name,create:()=>schema,jsonSchema});
  const string = codec('action',z.string(),{type:'string'}), json = codec('json',z.json(),{});
  return createInfo({package:'@yunshu/dsh-desktop/control',methods:{'yunshuControl/request':{
    service:'yunshuControl',description:'工作台本机功能开关',invocation:{kind:'direct'},
    parameters:[{name:'action',source:'json',codec:string,strictCodec:string},{name:'payload',source:'json',codec:json,strictCodec:json}],
    cancellation:{parameter:'signal'},result:json,sourceLocation:{file:'components/system/wire.mjs',line:1,column:1},
  }}},z);
}

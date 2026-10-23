import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameContainer } from './frames.js';
class Element {
  constructor(tag) { this.tag=tag;this.children=[];this.attributes={};this.listeners={};this.dataset={}; }
  setAttribute(key,value) {this.attributes[key]=value;}
  addEventListener(type,listener) {this.listeners[type]=listener;}
  append(...children) {for(const child of children){this.children.push(child);if(typeof child==='object')child.parent=this;}}
  remove() {this.parent.children=this.parent.children.filter(child=>child!==this);}
}
test('visited_frames_survive_selection_and_metadata_changes',async()=>{
  const previous={document:globalThis.document,fetch:globalThis.fetch,location:globalThis.location};
  globalThis.document={createElement:tag=>new Element(tag)};
  globalThis.location={protocol:'https:'};
  let status={status:'reachable',message:'Endpoint responds'};
  globalThis.fetch=async()=>({ok:true,json:async()=>status});
  try {
    const root=new Element('main');const frames=createFrameContainer(root);
    const first={id:'first',label:'First',embedding:'relative-paths',baseUrl:'http://localhost:8000/base/',uiUrl:'http://localhost:8000/base/page?q=1'};
    const second={...first,id:'second',label:'Second'};
    frames.open(first);const panel=root.children.find(child=>child.dataset?.appId==='first');
    const original=panel.children.find(child=>child.tag==='iframe');
    const retry=panel.children.find(child=>child.tag==='div').children.find(child=>child.tag==='button');
    assert.equal(original.attributes.src,'/apps/first/page?q=1');
    assert.equal(retry.hidden,true);
    await new Promise(setImmediate);
    assert.equal(panel.dataset.state,'reachable');
    assert.equal(retry.hidden,true);
    frames.open(second);assert.equal(panel.hidden,true);
    frames.open({...first,label:'Renamed',enabled:false});assert.equal(panel.hidden,false);
    assert.equal(panel.children.find(child=>child.tag==='iframe'),original);assert.equal(original.attributes.title,'Renamed');
    const other=root.children.find(child=>child.dataset?.appId==='second');
    frames.open({...first,uiUrl:'http://localhost:8000/base/changed?q=2'});
    assert.equal(panel.children.find(child=>child.tag==='iframe'),original);
    assert.equal(original.attributes.src,'/apps/first/page?q=1');
    frames.reload('first');assert.notEqual(panel.children.find(child=>child.tag==='iframe'),original);
    assert.equal(panel.children.find(child=>child.tag==='iframe').attributes.src,'/apps/first/changed?q=2');
    assert.equal(root.children.find(child=>child.dataset?.appId==='second'),other);
    frames.remove('first');assert.ok(!root.children.includes(panel));assert.ok(root.children.includes(other));
    frames.open({...first,id:'external',embedding:'external'});
    const external=root.children.find(child=>child.dataset?.appId==='external');assert.ok(!external.children.some(child=>child.tag==='iframe'));assert.equal(external.dataset.state,'incompatible');
    assert.equal(external.children.find(child=>child.tag==='div').children.find(child=>child.tag==='button').hidden,false);
    frames.open({...first,id:'direct',embedding:'direct'});const direct=root.children.find(child=>child.dataset?.appId==='direct');
    assert.equal(direct.dataset.state,'incompatible');assert.ok(!direct.children.some(child=>child.tag==='iframe'));
    status={status:'offline',message:'Stopped'};frames.open(second);await new Promise(setImmediate);assert.equal(other.dataset.state,'offline');
    assert.equal(other.children.find(child=>child.tag==='div').children.find(child=>child.tag==='button').hidden,false);
  } finally {Object.assign(globalThis,previous);}
});

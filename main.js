import {Canvas} from '/js/dom.js';
import {mat4} from '/js/gl-matrix-3.4.1/index.js';
import {getIDs, removeFromParent, show, hide, hidden} from '/js/util.js';
import {GLUtil} from '/js/gl-util.js';
import {Mouse3D} from '/js/mouse3d.js';

const ids = getIDs();
window.ids = ids;

const urlparams = new URLSearchParams(location.search);

const _G = {};

let canvas;
let gl;
let glutil;
let view;
let traces = [];
let restTrace, movingTrace;
let boostOrigin = {pos:[]};
let grid;
let boostVel = 0;
let boostSpace = 0;
let boostTime = 0;
let restTime = 0;
let dt = 0.05;
_G.boostFollow = false;
_G.showTrace = true;
_G.showPreBoost = true;
_G.showPostBoost = false;
let followTrace;

let lineObj;



/*
args:
	pts[2][3] points in space
	color[3] color of line
*/
function drawLine(args) {
	for (let i = 0; i < 3; i++) {
		lineObj.attrs.vertex.buffer.data[i] = args.pts[0][i];
		lineObj.attrs.vertex.buffer.data[i+3] = args.pts[1][i];
	}
	lineObj.attrs.vertex.buffer.updateData();

	//and do the draw ...
	lineObj.draw({
		uniforms : {
			color : args.color
		}
	});
}

function Trace(args) {
	this.state = args.state;
	this.color = args.color;
	this.accel = args.accel;
	this.history = [];
	this.rays = [];
}

let integrators = {
	euler : function(t, x, dt, f) {
		//return x + f(t,x) * t
		//but javascript sucks and doesn't let you overload operators
		return x.add(f(t,x).mul(dt));
	}
};
let integrate = integrators.euler;

function State(args) {
	this.x = [0,0]; 
	this.u = [1,0];
	this.tau = 0;
	if (args !== undefined) {
		if ('x' in args) {
			this.x[0] = args.x[0];
			this.x[1] = args.x[1];
		}
		if ('u' in args) {
			this.u[0] = args.u[0];
			this.u[1] = args.u[1];
		}
		if ('tau' in args) this.tau = args.tau;
	}
}
State.prototype = {
	add : function(otherState) {
		let a = this;
		let b = otherState;
		return new State({
			x : [a.x[0] + b.x[0], a.x[1] + b.x[1]],
			u : [a.u[0] + b.u[0], a.u[1] + b.u[1]],
			tau : a.tau + b.tau
		});
	},
	mul : function(s) {
		return new State({
			x : [this.x[0] * s, this.x[1] * s],
			u : [this.u[0] * s, this.u[1] * s],
			tau : this.tau * s
		});
	},
	integrate : function(dt, accel) {
		let tau = this.tau;
		let newState = integrate(tau, this, dt, function(tau, state) {
			let a;
			if (accel) {
				a = accel(state, tau);
			} else {
				a = 0;
			}
			
			/* Newton * /
			let dxds = new State({
				x : state.u,
				u : [1,a],
				tau : 1
			});
			/**/

			/* Minkowski */
			let v = state.u[1];
			//u[0] * a[0] - u[1] * a[1] = 0		<- orthogonal constraint
			//u[0] * a[0] = u[1] * a[1]
			//a[0] = a[1] * u[1] / u[0]
			a = [a*v, a];
			let dxds = new State({
				x : state.u,
				u : a,
				tau : 1
			});
			/**/
			return dxds;
		});
		//Minkowski : post-integration renormalize velocity
		newState.u[0] = Math.sqrt(newState.u[1] * newState.u[1] + 1);
		return newState;
	},
	toString : function() {
		return JSON.stringify({
			x:this.x,
			u:this.u,
			tau:this.tau
		});
	}
};

function resize() {
	canvas.width = window.innerWidth;
	canvas.height = window.innerHeight;

	view.aspectRatio = canvas.width / canvas.height;
	view.calcRange();

	glutil.view.ortho = true;
	glutil.view.pos[0] = (view.maxX + view.minX) / 2; 
	glutil.view.pos[1] = (view.maxY + view.minY) / 2; 
	glutil.view.pos[2] = 10;
	glutil.view.fovY = (view.maxY - view.minY) / 2;

	glutil.resize();


	let info = ids.info;
	let width = window.innerWidth 
		- parseInt(info.style.padingLeft)
		- parseInt(info.style.paddingRight);
	info.style.width = width + 'px';
	let height = window.innerHeight
		- parseInt(info.style.paddingTop)
		- parseInt(info.style.paddingBottom);
	info.style.height = (height - 32)+'px';
}

function update() {

	//update code here
	
	boostOrigin.pos[0] = boostSpace;
	boostOrigin.pos[1] = boostTime;

	//update simulation

	// emit light beams at each state every tick of their local clock

	let lastRestTime = restTime;
	restTime += dt;

	let emitPeriod = 1;

	for (let traceIndex = 0; traceIndex < traces.length; traceIndex++) {
		let trace = traces[traceIndex];
		if (trace.state.x[0] <= view.baseRange.maxY) {
			if (trace.history.length > 0) {
				let thisTick = Math.floor(trace.state.tau);
				let lastTick = Math.floor(trace.history[trace.history.length-1].tau / emitPeriod);
				if (thisTick != lastTick) {
					let oldState = trace.state;
					for (let dir = -1; dir <= 1; dir += 2) {
						let state = new State(oldState);
						state.u = [1,dir];
						trace.rays.push({
							src : new State(state),
							dst : new State(state)
						});
					}
				}
			}
		}
	}

	// integrate states
	for (let traceIndex = 0; traceIndex < traces.length; traceIndex++) {
		let trace = traces[traceIndex];
		if (trace.state.x[0] <= view.baseRange.maxY) {
			let oldp = trace.state;
			trace.state = oldp.integrate(dt / oldp.u[0], trace.accel);
			trace.history.push(oldp);
		}
		for (let rayIndex = 0; rayIndex < trace.rays.length; rayIndex++) {
			let ray = trace.rays[rayIndex];
			if (ray.dst.x[0] <= view.baseRange.maxY) {
				// integrate without relativity
				ray.dst.x[1] = ray.dst.x[1] + ray.dst.u[1] * dt;
				ray.dst.x[0] = ray.dst.x[0] + ray.dst.u[0] * dt;
			}
		}
	}

	glutil.ondraw = function() {

		let renderGrid = function() {
			//render grid
			for (let i=Math.ceil(view.minX); i <= Math.floor(view.maxX); i++) { 
				drawLine({			
					pts:[
						[i, view.minY, 0],
						[i, view.maxY, 0]
					],
					color:[.25,.25,.25]
				});
			}
			for (let i=Math.ceil(view.minY); i <= Math.floor(view.maxY); i++) {
				drawLine({
					pts:[
						[view.minX, i, 0],
						[view.maxX, i, 0]
					],
					color:[.25,.25,.25]
				});
			}
		};
		
		if (_G.showPreBoost) {
			renderGrid();
		}
		
		//applyBoost
		{
			let boostU = [1,0];
			if (_G.boostFollow) {
				if (followTrace) {
					boostSpace = followTrace.state.x[1];
					boostTime = followTrace.state.x[0];
					boostVel = followTrace.state.u[1] / followTrace.state.u[0];
				}
			}
			boostU = [
				1 / Math.sqrt(1 - boostVel * boostVel),
				boostVel * boostU[0]
			];
			let boostX = [boostSpace,boostTime];
			mat4.translate(glutil.scene.mvMat, glutil.scene.mvMat, [boostX[1], boostX[0], 0]);
			
			let u0 = boostU[0];
			let u1 = boostU[1];
			let boostMatrix = mat4.create();	//initializes to identity
			boostMatrix[0] = u0;
			boostMatrix[1] = -u1;
			boostMatrix[4] = -u1;
			boostMatrix[5] = u0;	//symmetric, so if the matrix is transposed it won't matter
			mat4.multiply(glutil.scene.mvMat, glutil.scene.mvMat, boostMatrix);
			mat4.translate(glutil.scene.mvMat, glutil.scene.mvMat, [-boostX[1], -boostX[0], 0]);
		}

		if (_G.showPostBoost) {
			renderGrid();
		}

		// render boost origin
		mat4.translate(glutil.scene.mvMat, glutil.scene.mvMat, [boostSpace, boostTime, 0]);
		for (let i = 0; i < 360; i++) {
			let theta1 = i / 180 * Math.PI;
			let x1 = .5 * Math.cos(theta1);
			let y1 = .5 * Math.sin(theta1);
			let theta2 = (i+1) / 180 * Math.PI;
			let x2 = .5 * Math.cos(theta2);
			let y2 = .5 * Math.sin(theta2);
			drawLine({pts:[[x1,y1,0],[x2,y2,0]], color:[1,1,0]});
		}
		drawLine({pts:[[-1,0,0],[1,0,0]], color:[1,1,0]});
		drawLine({pts:[[0,-1,0],[0,1,0]], color:[1,1,0]});
		drawLine({pts:[[-100,0,0],[100,0,0]], color:[.75,.5,0]});
		mat4.translate(glutil.scene.mvMat, glutil.scene.mvMat, [-boostSpace, -boostTime, 0]);
	
		//render rays as lines
		if (_G.showTrace) {
			for (let traceIndex = 0; traceIndex < traces.length; traceIndex++) {
				let trace = traces[traceIndex];
				for (let rayIndex = 0; rayIndex < trace.rays.length; rayIndex++) {
					let ray = trace.rays[rayIndex];
					drawLine({
						pts:[
							[ray.src.x[1], ray.src.x[0], 0],
							[ray.dst.x[1], ray.dst.x[0], 0]
						],
						color:[
							trace.color[0]*.5,
							trace.color[1]*.5,
							trace.color[2]*.5
						]
					});
				}
			}
		}

		//render state history
		for (let traceIndex = 0; traceIndex < traces.length; traceIndex++) {
			let trace = traces[traceIndex];
			for (let i = 0;	i < trace.history.length-1; i++) {
				drawLine({
					pts:[
						[trace.history[i].x[1], trace.history[i].x[0], 0],
						[trace.history[i+1].x[1], trace.history[i+1].x[0], 0],
					],
					color:trace.color
				});
			}
		}
	};

	glutil.draw();

	requestAnimationFrame(update);

	if (restTime > 50) initProblem();
}

function initProblem() {
	restTime = 0;

	traces = [];
	restTrace = new Trace({
		state : new State({x:[0,5]}),
		color : [1,0,0]
	});
	restTrace.name = 'Rest';
	traces.push(restTrace);


	movingTrace = new Trace({
		state : new State({x:[0,5.1]}),
		color : [0,1,0],
		accel : function(state, properTime) {
			let movingAccel = .2;
			let startDelay = 2;
			let changeTime = 4;
			let measuredTime = properTime; //state.x[0]
			if (measuredTime < startDelay) return 0; //	wait one second
			if (measuredTime < startDelay + changeTime) return movingAccel;
			if (measuredTime < startDelay + changeTime * 3) return -movingAccel;
			if (measuredTime < startDelay + changeTime * 4) return movingAccel;
			return 0;
		}
	});
	movingTrace.name = 'Moving';
	traces.push(movingTrace);
	
	followTrace = movingTrace;

}

ids.panelButton.addEventListener('click', e => {
	if (hidden(ids.panel)) {
		show(ids.panel);
		hide(ids.info);
	} else {
		hide(ids.panel);
	}
});
ids.infoButton.addEventListener('click', e => {
	if (hidden(ids.info)) {
		show(ids.info);
		hide(ids.panel);
	} else {
		hide(ids.info);
	}
});

canvas = Canvas({
	style : {
		left : 0,
		top : 0,
		position : 'absolute',
		userSelect : 'none',
	},
	prependTo : document.body,
});

try {
	glutil = new GLUtil({canvas:canvas});
	gl = glutil.context;
} catch (e) {
	removeFromParent(canvas);
	show(ids.webglfail);
	throw e;
}
show(ids.menu);

glutil.dontDrawOnResize = true;

['boostFollow', 'showTrace', 'showPreBoost', 'showPostBoost'].forEach(field => {
	const o = document.querySelector('input[name='+field+']');
	o.addEventListener('change', e => {
		_G[field] = o.checked;
	});
	o.checked = _G[field];
});

let plainShader = new glutil.Program({
	vertexCode : `
in vec3 vertex;
uniform mat4 mvMat;
uniform mat4 projMat;
void main() {
	vec4 eyePos = mvMat * vec4(vertex, 1.);
	gl_Position = projMat * eyePos;
}
`,
	fragmentCode : `
uniform vec3 color;
out vec4 fragColor;
void main() {
	fragColor = vec4(color, 1.);
}
`,
});

lineObj = new glutil.SceneObject({
	mode : gl.LINES,
	shader : plainShader,
	uniforms : { color : [1,1,1] },
	attrs : { 
		vertex : new glutil.ArrayBuffer({
			data : new Float32Array(6),
			usage : gl.DYNAMIC_DRAW
		})
	},
	parent : null,
	static : true
});

initProblem();

view = {
	posX : 0, posY : 0,
	minX : 0, minY : 0,
	maxX : 0, maxY : 0,
	s : 0,
	calcRange : function() {
		this.baseRange = {
			minX : -20, minY : 0/this.aspectRatio,
			maxX : 20, maxY : 40/this.aspectRatio
		};
		let baseCenterX = (this.baseRange.maxX + this.baseRange.minX) * .5;
		let baseCenterY = (this.baseRange.maxY + this.baseRange.minY) * .5;
		this.minX = this.posX + (this.baseRange.minX - baseCenterX) / Math.exp(this.s) + baseCenterX;
		this.minY = this.posY + (this.baseRange.minY - baseCenterY) / Math.exp(this.s) + baseCenterY;
		this.maxX = this.posX + (this.baseRange.maxX - baseCenterX) / Math.exp(this.s) + baseCenterX;
		this.maxY = this.posY + (this.baseRange.maxY - baseCenterY) / Math.exp(this.s) + baseCenterY;
	}
};

window.addEventListener('resize', resize);
resize();
update();

var canvas;
var panel;
var gl;
var plainShader;
var view;
var traces = [];
var restTrace, movingTrace;
var boostOrigin = {pos:[]};
var grid;
var boostVel = 0;
var boostSpace = 0;
var boostTime = 0;
var restTime = 0;
var dt = 0.05;
var boostFollow = false;
var showTrace = true;
var showPreBoost = true;
var showPostBoost = false;
var followTrace;

var lineArray = [];
var lineBuffer;
var lineObj;



/*
args:
	pts[2][3] points in space
	color[3] color of line
*/
function drawLine(args) {
	for (var i = 0; i < 3; i++) {
		lineArray[i] = args.pts[0][i];
		lineArray[i+3] = args.pts[1][i];
	}
	lineBuffer.updateData(lineArray);
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

var integrators = {
	euler : function(t, x, dt, f) {
		//return x + f(t,x) * t
		//but javascript sucks and doesn't let you overload operators
		return x.add(f(t,x).mul(dt));
	}
};
var integrate = integrators.euler;

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
		var a = this;
		var b = otherState;
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
		var tau = this.tau;
		var newState = integrate(tau, this, dt, function(tau, state) {
			var a;
			if (accel) {
				a = accel(state, tau);
			} else {
				a = 0;
			}
			
			/* Newton * /
			var dxds = new State({
				x : state.u,
				u : [1,a],
				tau : 1
			});
			/**/

			/* Minkowski */
			var v = state.u[1];
			//u[0] * a[0] - u[1] * a[1] = 0		<- orthogonal constraint
			//u[0] * a[0] = u[1] * a[1]
			//a[0] = a[1] * u[1] / u[0]
			a = [a*v, a];
			var dxds = new State({
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

	GL.view.ortho = true;
	GL.view.pos[0] = (view.maxX + view.minX) / 2; 
	GL.view.pos[1] = (view.maxY + view.minY) / 2; 
	GL.view.pos[2] = 10;
	GL.view.fovY = (view.maxY - view.minY) / 2;
	GL.resize();
}

function update() {

	//update code here
	
	boostOrigin.pos[0] = boostSpace;
	boostOrigin.pos[1] = boostTime;

	//update simulation

	// emit light beams at each state every tick of their local clock

	var lastRestTime = restTime;
	restTime += dt;

	var emitPeriod = 1;

	for (var traceIndex = 0; traceIndex < traces.length; traceIndex++) {
		var trace = traces[traceIndex];
		if (trace.state.x[0] <= view.baseRange.maxY) {
			if (trace.history.length > 0) {
				var thisTick = Math.floor(trace.state.tau);
				var lastTick = Math.floor(trace.history[trace.history.length-1].tau / emitPeriod);
				if (thisTick != lastTick) {
					var oldState = trace.state;
					for (var dir = -1; dir <= 1; dir += 2) {
						var state = new State(oldState);
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
	for (var traceIndex = 0; traceIndex < traces.length; traceIndex++) {
		var trace = traces[traceIndex];
		if (trace.state.x[0] <= view.baseRange.maxY) {
			var oldp = trace.state;
			trace.state = oldp.integrate(dt / oldp.u[0], trace.accel);
			trace.history.push(oldp);
		}
		for (var rayIndex = 0; rayIndex < trace.rays.length; rayIndex++) {
			var ray = trace.rays[rayIndex];
			if (ray.dst.x[0] <= view.baseRange.maxY) {
				// integrate without relativity
				ray.dst.x[1] = ray.dst.x[1] + ray.dst.u[1] * dt;
				ray.dst.x[0] = ray.dst.x[0] + ray.dst.u[0] * dt;
			}
		}
	}

	GL.ondraw = function() {
	
		var renderGrid = function() {
			//render grid
			for (var i=Math.ceil(view.minX); i <= Math.floor(view.maxX); i++) { 
				drawLine({			
					pts:[
						[i, view.minY, 0],
						[i, view.maxY, 0]
					],
					color:[.25,.25,.25]
				});
			}
			for (var i=Math.ceil(view.minY); i <= Math.floor(view.maxY); i++) {
				drawLine({
					pts:[
						[view.minX, i, 0],
						[view.maxX, i, 0]
					],
					color:[.25,.25,.25]
				});
			}
		};
		
		if (showPreBoost) {
			renderGrid();
		}
		
		//applyBoost
		{
			var boostU = [1,0];
			if (boostFollow) {
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
			var boostX = [boostSpace,boostTime];
			mat4.translate(GL.mvMat, GL.mvMat, [boostX[1], boostX[0], 0]);
			
			var u0 = boostU[0];
			var u1 = boostU[1];
			var boostMatrix = mat4.create();	//initializes to identity
			boostMatrix[0] = u0;
			boostMatrix[1] = -u1;
			boostMatrix[4] = -u1;
			boostMatrix[5] = u0;	//symmetric, so if the matrix is transposed it won't matter
			mat4.multiply(GL.mvMat, GL.mvMat, boostMatrix);
			mat4.translate(GL.mvMat, GL.mvMat, [-boostX[1], -boostX[0], 0]);
		}

		if (showPostBoost) {
			renderGrid();
		}

		// render boost origin
		mat4.translate(GL.mvMat, GL.mvMat, [boostSpace, boostTime, 0]);
		for (var i = 0; i < 360; i++) {
			var theta1 = i / 180 * Math.PI;
			var x1 = .5 * Math.cos(theta1);
			var y1 = .5 * Math.sin(theta1);
			var theta2 = (i+1) / 180 * Math.PI;
			var x2 = .5 * Math.cos(theta2);
			var y2 = .5 * Math.sin(theta2);
			drawLine({pts:[[x1,y1,0],[x2,y2,0]], color:[1,1,0]});
		}
		drawLine({pts:[[-1,0,0],[1,0,0]], color:[1,1,0]});
		drawLine({pts:[[0,-1,0],[0,1,0]], color:[1,1,0]});
		drawLine({pts:[[-100,0,0],[100,0,0]], color:[.75,.5,0]});
		mat4.translate(GL.mvMat, GL.mvMat, [-boostSpace, -boostTime, 0]);
	
		//render rays as lines
		if (showTrace) {
			for (var traceIndex = 0; traceIndex < traces.length; traceIndex++) {
				var trace = traces[traceIndex];
				for (var rayIndex = 0; rayIndex < trace.rays.length; rayIndex++) {
					var ray = trace.rays[rayIndex];
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
		for (var traceIndex = 0; traceIndex < traces.length; traceIndex++) {
			var trace = traces[traceIndex];
			for (var i = 0;	i < trace.history.length-1; i++) {
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

	GL.draw();
	requestAnimFrame(update);

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
			var movingAccel = .2;
			var startDelay = 2;
			var changeTime = 4;
			var measuredTime = properTime; //state.x[0]
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

$(document).ready(function(){
	canvas = $('<canvas>', {
		css : {
			left : 0,
			top : 0,
			position : 'absolute'
		}
	}).prependTo(document.body).get(0);
	$(canvas).disableSelection();
	panel = $('#panel');

	try {
		gl = GL.init(canvas);
	} catch (e) {
		panel.remove();
		$(canvas).remove();
		$('#webglfail').show();
		throw e;
	}

	$('input[name=boostFollow]').change(function() {
		boostFollow = $('input[name=boostFollow]').get(0).checked;
	}).get(0).checked = boostFollow;
	$('input[name=showTrace]').change(function() {
		showTrace = $('input[name=showTrace]').get(0).checked;
	}).get(0).checked = showTrace;
	$('input[name=showPreBoost]').change(function() {
		showPreBoost = $('input[name=showPreBoost]').get(0).checked;
	}).get(0).checked = showPreBoost;
	$('input[name=showPostBoost]').change(function() {
		showPostBoost = $('input[name=showPostBoost]').get(0).checked;
	}).get(0).checked = showPostBoost;

	plainShader = new GL.ShaderProgram({
		vertexCodeID : 'plain-vsh',
		fragmentCodeID : 'plain-fsh'
	});

	lineArray = new Float32Array(6);

	lineBuffer = new GL.ArrayBuffer({
		data : lineArray,
		usage : gl.DYNAMIC_DRAW
	});

	lineObj = new GL.SceneObject({
		mode : gl.LINES,
		count : 2,
		shader : plainShader,
		uniforms : { color : [1,1,1] },
		attrs : { vtx : lineBuffer }
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
			var baseCenterX = (this.baseRange.maxX + this.baseRange.minX) * .5;
			var baseCenterY = (this.baseRange.maxY + this.baseRange.minY) * .5;
			this.minX = this.posX + (this.baseRange.minX - baseCenterX) / Math.exp(this.s) + baseCenterX;
			this.minY = this.posY + (this.baseRange.minY - baseCenterY) / Math.exp(this.s) + baseCenterY;
			this.maxX = this.posX + (this.baseRange.maxX - baseCenterX) / Math.exp(this.s) + baseCenterX;
			this.maxY = this.posY + (this.baseRange.maxY - baseCenterY) / Math.exp(this.s) + baseCenterY;
		}
	};

	$(window).resize(resize);
	resize();
	update();
});



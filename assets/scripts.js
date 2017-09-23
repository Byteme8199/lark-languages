
/********************************/
/* /js/html5_player.js */
/********************************/

"use strict";

var Logger = {
	logInBrowser: false,
	logVerbosely: false,
	logRecord: [],
	log: function(message) {
		this.logInBrowser && console.log(message);
		this.logRecord.push(message);
	},
	logVerbose: function(message) {
		if (!this.logVerbosely) return;

		this.logInBrowser && console.log(message);
		this.logRecord.push(message);
	},
	getLogs: function() { return this.logRecord.join('\n'); },
	dumpLogs: function() {
		var oldLogs = this.getLogs();
		this.logRecord = [];
		return oldLogs;
	}
}

var event_mixin = {
	bind: function() { $.fn.on.apply($(this), Array.prototype.slice.apply(arguments)); return this; },
	trigger: function() { $.fn.trigger.apply($(this), Array.prototype.slice.apply(arguments)); return this; },
	triggerHandler: function() { $.fn.triggerHandler.apply($(this), Array.prototype.slice.apply(arguments)); return this; },
	unbind: function() { $.fn.off.apply($(this), Array.prototype.slice.apply(arguments)); return this; }
};

var LarkLanguages = (function($) {

/* for performance reasons, captions are preloaded as
var CAPTIONS = {massive json data} */


var localStorageWrap = {
	getItem: function(key) {
		try {
			var res = window.localStorage.getItem(key);
			return res;
		} catch (e) {
			return null;
		}
	},
	setItem: function(key,val) {
		try {
			var res = window.localStorage.setItem(key,val);
			return res;
		} catch (e) {
			return null;
		}
	}

}

/* ***************************************************
 *
 * Utility Functions
 *  tacked on to jQuery
 *
 * **************************************************/
$.sum = function(lhs, rhs) { return lhs + rhs; };
$.clamp = function (v,min,max) {
	return Math.min(Math.max(v,min),max);
};

var caption_methods = {

	getCaptionIndexFromTime: function (time) {
		var caption,i;
		time = time + .0001;  // Fix the seeking issue in the spec.
		for(i=0;i<this.length;i++) {
			caption = this[i];
			if(time >= caption.time_in) {
				if (i == this.length-1 || time < this[i+1].time_in) { 
					if(caption.time_out && caption.time_out < time) 
						return null; 
					return i;
				}
			} 
		}
		return null;
	},
	getPreviousCaptionIndexFromTime: function(time,buffer) {
		if(!buffer)
			buffer = .8;
		for(var i = this.length-1;i>=0;i--) {
			if(time > this[i].time_in + buffer) {
				return i
			}
		}
		return null;
	},
	getNextCaptionIndexFromTime: function(time) {
		for(var i=0;i<this.length;i++) {
			if(this[i].time_in > time+.1) {
				return i;
			}
		}
		return null;
	},
	getCaptionFromTime: function(time) {
		var idx = this.getCaptionIndexFromTime(time);
		if (idx != null)
			return this[idx];
		return null;
	},
	getFrameOutByIndex: function(index) { 
		if(index < this.length - 1) {
			if(this[index].frame_out) {
				return Math.min(this[index].frame_out,this[index+1].frame_in);
			} 
			return this[index+1].frame_in;
		
		}
	
		if(this[index].frame_out) {
				return this[index].frame_out;
		} 
		// POTENTIAL BUG!!!!!!!! -jc
		// this is a problem. Case where last caption has no frame_out.
		// since the CaptionManager is "unaware" of the number of video frames. 
		return this[index].frame_in + 1000;
	
	},
	getTimeOutByIndex: function(index) { 
		if(index < this.length - 1) {
			if(this[index].frame_out) {
				return Math.min(this[index].time_out,this[index+1].time_in);
			} 
			return this[index+1].time_in;
		
		}
	
		if(this[index].frame_out) {
				return this[index].time_out;
		} 
		// POTENTIAL BUG!!!!!!!! -jc
		// this is a problem. Case where last caption has no frame_out.
		// since the CaptionManager is "unaware" of the number of video frames. 
		return this[index].time_in + 100;
	
	}
}


/* ***************************************************
 *
 * Video Controllers & View Elements
 *
 * **************************************************/
var vcCommonMethods = {
	_atVideoEnd: false,
	_loopForever: false,
	seekEndHandler: function() {
		if($.isNumeric(this._seek_target) )  {
			this.seekTo(this._seek_target);
			this._seek_target = null;
		} 
	},
	seekTo: function(time,force) {
		var from = this.currentTime();
		this.onSeek && this.onSeek(time);
		this._atVideoEnd = false;
		if($.isNumeric(time) && this.isVideoReady()) {
			if(this.isSeeking()) {
				this._seek_target = time;

				if(force) {  // There is a safari bug, where the video's state gets stuck in "seeking", and breaks the game.  
					try {
						this._setCurrentTime(time);
						this.trigger('seekstarted', { to: time, from: from });
					} catch (err) { } 
				}
			} else {
				this._setCurrentTime(time);
				this.trigger('seekstarted', { to: time, from: from });
			}
			// this causes a flash in the player, but does it prevent other bugs?
			//this.trigger('timeupdate',{ currentTime: time, duration: this.duration() });
		}
	},
	seekToCaption: function(index) {
		if(index || index === 0) {
			this._loop_target = index;
			this.seekTo(this.captions[index].time_in);
			this.caption_index = index;
		}
	},
	seekToPercent: function(percent) {
		this.seekTo(this.toVideoTime(this.duration() * percent));
	},
	poll: function() {
		var t = this.currentTime();
		var c = this.captions.getCaptionIndexFromTime(t);

		// If we overshoot on the back / skip button, don't flash the last caption
		if(this.back_target_index === c + 1) {
			if(this.captions[this.back_target_index].time_in - t < this.back_overshoot_allowance)
				return;
		}
		if(this.skip_target_index === c + 1) {
			if(this.captions[this.skip_target_index].time_in - t < this.back_overshoot_allowance)
				return;
		}

		var passedVideoEnd = this.duration() && t >= this.videoRange.end - 0.1;
		var me = this;
		function loop() {
			if(!me.captions[me.current_caption]) {
				return;
			}
			var capLength = me.captions[me.current_caption].time_out - me.captions[me.current_caption].time_in;
			if (!me._firstLoop) {
				me._firstLoop = true;
				me.seekToCaption(me.current_caption);
				setTimeout(function() { me._firstLoop = false; }, Math.min(1000*capLength/3,1500) );
			}
		}

		// check time & adjust if necessary
		if(this.range_play_stop_time && t > this.range_play_stop_time) {
			// check for range play
			this.pause();
			this.seekTo(this.range_play_start_time);
			this.trigger('rangeplayend');
		} else if (passedVideoEnd) {
			// check for video end
			if (this._captionLoop) {
				loop();
			} else if (this._loopForever) {
				this.playFromBeginning();
			} else if (!this._atVideoEnd) {
				this.pause();
				this.trigger('videoended', { end: this.videoRange.end, duration: this.duration() });
				this._atVideoEnd = true;
			}
		} else if (c !== this.current_caption) {

			if(!this._captionLoop) {
				this.current_caption = c;
				this.trigger('captionchange', { caption_index:c });
			} else {
	 			// handle caption change
				// Loop mode
				// If: .3 seconds ago, was the current caption
				// we were not seeking to the new caption
				// we are one ahead of the current caption, or in a null region.
				// go back to the beginning.
				var passedEnd = this.captions.getCaptionIndexFromTime(t-.3) == this.current_caption
					&& this._loop_target !== c && (c == this.current_caption + 1 || c === null);

				// if we are looping and go too far back
				// this prevents flashing 
				var max_probable_back_overshoot = this.is_youtube ? 1.5 : 0.5;
				var beforeBeginning =  
					this.captions.getCaptionIndexFromTime(t+max_probable_back_overshoot) == this.current_caption
					&& c == this.current_caption - 1;

				if (passedEnd) {
					// the caption should loop
					loop();
				} else if(beforeBeginning) {
					// do nothing, play through
				} else {
					// trigger caption change
					this.current_caption = c;
					this.trigger('captionchange', { caption_index:c });
				}
			}
		}

		this.onPoll && this.onPoll();
	},
	duration: function() { 
		if(this.videoRange.end > 0) {
			return this.videoRange.end - this.videoRange.start; 
		}
		
	},
	toSegmentTime: function(time) { return time - this.videoRange.start; },
	toVideoTime: function(time) { return time + this.videoRange.start; },
	// used by the game
	playRange: function(start_time, end_time) {
		this.seekTo(start_time,true);
		this.play();
		this.setPlayRange(start_time, end_time);
	},
	setPlayRange: function(start_time, end_time) {
		this.range_play_start_time = start_time;
		this.range_play_stop_time = end_time;

		// a bit of safety, this acutally may be a bug fix.
		this.back_target_index = null;
		this.skip_target_index = null;
	},
	endRangePlay: function() {
		this.range_play_start_time = null;
		this.range_play_stop_time = null;
	},
	isPlayingRange: function() {
		return (this.range_play_start_time != null && this.range_play_stop_time != null);
	},
	togglePlay: function() {
		this.isPaused() ?
			this.play() :
			this.pause();
	},
	isSlow: function() {
		return this.playbackRate() <= .99;
	},
	slow: function() {
		this.setPlaybackRate(this.slowSpeed);
		this._slow = true;
	},
	fast: function() {
		// fucking firefox bug
		var pbr = navigator.userAgent.indexOf('Firefox') != -1 ? 1.0001 : 1;

		this.setPlaybackRate(pbr);
		this._slow = false;
	},
	toggleSlow: function() {
		this.isSlow() ? this.fast() : this.slow();
	},
	startCaptionLoop: function() {
		this._captionLoop = true;
		this.trigger('loopchange',{ loop: this._captionLoop });
	},
	endCaptionLoop: function() {
		this._captionLoop = false;
		this.trigger('loopchange',{ loop: this._captionLoop });
	},
	toggleCaptionLoop: function() {
		this._captionLoop ? this.endCaptionLoop() : this.startCaptionLoop();
	},
	setLoopForever: function(loop) { this._loopForever = loop; },
	getLoopForever: function() { return this._loopForever },
	playFromBeginning: function() {
		this.seekTo(this.videoRange.start);
		this.play();
	},
	back: function() {
		this.back_target_index = this.captions.getPreviousCaptionIndexFromTime(this.targetOrCurrentTime());
		if(this.back_target_index !== null) {
			this.seekToCaption(this.back_target_index);
		} else {
			this.seekTo(this.videoRange.start);
		}
		this.skip_target_index = null;
	},
	skip: function() {
		this.skip_target_index = this.captions.getNextCaptionIndexFromTime(this.targetOrCurrentTime());
		if(this.skip_target_index !== null) {
			this.seekToCaption(this.skip_target_index);
		} else {
			this.seekTo(this.videoRange.end);
		}
		this.back_target_index = null;
	},
	// rewind feature in cloze game.
	backNSeconds: function(secs) {
		var ct = this.targetOrCurrentTime();
		var t = Math.max(ct - secs, this.range_play_start_time || 0.0);

		// a hack for when at the end
		if(this.isPaused() && ct < this.range_play_start_time + 0.1) {
			t = this.range_play_stop_time - secs;
		}
		this.seekTo(t);
	},
	targetOrCurrentTime: function() {
		return (this.isSeeking() && this._seek_target) ? this._seek_target : this.currentTime();
	},

}

function VideoController(src,captions,poster_url, back_overshoot_allowance, video_range) {
	this.init(src,captions,poster_url, back_overshoot_allowance, video_range);
}
$.extend(VideoController.prototype, {
	progress: 0,
	init: function(src,captions,poster_url, back_overshoot_allowance, video_range) {
		this.captions = captions;
		this.back_overshoot_allowance = back_overshoot_allowance;
		this.videoRange = (video_range && video_range.end) ? video_range : {start:0.0, end:null};
		var me = this;
		var duration_triggered = false;
		this.$e = $('#video_container');

		this.slowSpeed = 0.7;
		this._video = $('<video oncontextmenu="return false;"/>')
			.attr('src',src)
			.attr('controls',false)
			.attr('autoplay',true)
			.attr('playsinline',true)
			.prependTo(this.$e)
			.attr('preload','auto')
			.get(0);

		$(this._video).bind('progress loadstart loadedmetadata play suspend abort emptied',function(e) {
			if(this.duration && !duration_triggered) {
				if ( !me.duration() ) {
					me.videoRange.start = 0.0;
					me.videoRange.end = this.duration;
					me._videoRangeSetByMedia = true;
				}
				me.trigger('durationavailable',{ duration: me.duration() });
				duration_triggered = true;
			} 
			// This is an insane attempt to fix things on Android.  I think 
			// it changes the duration from one positive value to another.
			else if(this.duration && this.duration != me.videoRange.end && me._videoRangeSetByMedia) {
				me.videoRange.end = this.duration;
			}
		}).bind('canplay canplaythrough playing', function(e) {
			if (e.type == 'playing')
				e.type = 'firstplay';
			me.trigger(e.type);
		}).bind('timeupdate',function() {
			if(!this.seeking) {
				me.trigger('timeupdate',{ currentTime: this.currentTime, duration: me.duration() });
			}
		}).bind('loadedmetadata',function() {
			if ( localStorageWrap.getItem('volume') ) {
				me.setVolume(
					Math.max(localStorageWrap.getItem('volume'),.5)
				);
			}
			me.seekTo(me.videoRange.start);
			me.trigger('loadingfinished');
		}).bind('error',function(e) {
			me.mediaErrorHandler(e);
		}).bind('seeked',function(e) {
			me.seekEndHandler(e);
		});
		$(this._video).bind('waiting pause play playing',function(e) {
			me.trigger('playstatechange');
		});

		(function pollBuffer() {
			me.progress = 0;
			if(me._video.buffered && me._video.buffered.length && me.duration()) {
				var done = false;
				var pos = me._video.buffered.length-1;
				if(pos === 0) {
					me.progress = (me._video.buffered.end(pos)) / me.duration();
					me.trigger('progress', { progress: me.progress } );
					if(me.progress > .99) {
						done = true;
					}
				} else {
					me.trigger('multi_progress',{buffer: me._video.buffered, duration: me.duration()});
				}

			}
			!done && setTimeout(pollBuffer,800);
		})();

		setInterval($.proxy(this.poll,this),65);

	},
	resizeVideo: function() {
		var aspect = this.videoAspectRatio();
		if(!aspect) {
			return;
		}
		var container_aspect = this.$e.width() / this.$e.height();
		var css =
			aspect > container_aspect ?
			{
				width: Math.floor(this.$e.width()),
				height: Math.floor(this.$e.width() / aspect),
				top:  Math.round( (this.$e.height() - this.$e.width() / aspect) / 2),
				left:0
			}
			:
			{
				height: Math.floor(this.$e.height()),
				width: Math.floor(this.$e.height() * aspect),
				left: Math.round((this.$e.width() - this.$e.height() * aspect) / 2),
				top:0
			};
		$(this._video).css(css);
	},
	videoWidth: function() { return $(this._video).width(); },
	videoAspectRatio: function() {
		if(this._video && this.nativeWidth()) {
			return this.nativeWidth() / this.nativeHeight();
		}
		return;
	},
	mediaErrorHandler: function(e) {
		var n = ['empty','idle','loading','loaded','no_source'][this._video.networkState];
		var e =
			['?','aborted','network','decode','src_not_supported'][this._video.error ? this._video.error.code : 0];

		setTimeout(function(){
			//throw new Error("Media error: "+ e + ' Network State:' + n);
		},1000);  // a pretty big delay, because chrome throws errors when the page is being unloaded.

	},
	isSeeking: function() { return this._video.seeking; },
	isVideoReady: function() { return this._video.readyState >= 2; },
	fadeOut: function(onDone) {
		var me = this;
		var origVol = this.getVolume();
		var stepSize = 0.05;
		var stepTime = 50;
		function doFade() {
			setTimeout(function() {
				if (me.getVolume() > 0) {
					me.setVolume(Math.max(0, me.getVolume() - stepSize));
					doFade();
				} else {
					me.setVolume(origVol);
					me.pause();
					onDone && onDone();
				}
			}, stepTime);
		}
		doFade();
	},
	play: function() {
		this._video.play();
		this._atVideoEnd = false;
		this.triggerHandler('play');
		if(this._slow) {
			this.setPlaybackRate(this.slowSpeed);  // this seems redundant, but IE reverts to playback rate 0.7, rather than the last playback rate.
		}
	},
	pause: function() {
		this._video.pause();
		this.triggerHandler('pause');
	},
	animateVideoSize: function(size, animation_duration, callback) {
		$(this._video).animate(size, animation_duration, callback && callback());
	},
	isPaused: function() {return this._video.paused;},
	currentTime: function() {return this._video.currentTime;},
	_setCurrentTime: function(time) {this._video.currentTime = time;},
	atEnd: function() {return false;},
	getVolume: function() { return this._video.volume; },
	setVolume: function(vol) {
		vol = $.clamp(vol, 0,1);
		this.lastVolume = this.getVolume();
		this._video.volume = vol;
		localStorageWrap.setItem('volume', vol);
		this.trigger('volumechanged', [vol]);
	},
	restoreVolume: function() { this.setVolume(this.lastVolume || 1); },
	nativeWidth: function() {return this._video.videoWidth;},
	nativeHeight: function() {return this._video.videoHeight;},
	playbackRate: function() {return this._video.playbackRate;},
	setPlaybackRate: function(pbr) {
		this._video.playbackRate = pbr;
		if (pbr >= 0.99 && pbr <= 1.01) pbr = 1;
		this.trigger('ratechange', { rate: pbr });
	},
	getAvailablePlaybackRates: function() { return false; },

},event_mixin,vcCommonMethods);


function ScrubBar(vc,captions) {
	this.init(vc,captions);
}
$.extend(ScrubBar.prototype,{
	init: function(vc,captions) {
		this.vc = vc;
		this.$e = $('.scrub_bar');
		this.$scrubber = this.$e.find('.scrubber');
		this.$track = this.$e.find('.track');
		this.$touch_scrubber = this.$e.find('.touch_scrubber');
		this.last_progress = 0;

		var me = this;
		this.updateProgress(0);
		this.vc.bind('timeupdate',function(e,d) {
			if (me.vc.atEnd())
				return;
			d.duration && me.positionSlider(me.vc.toSegmentTime(d.currentTime) / d.duration);
			d.duration && me.createSegments(captions, d.duration);
		});
		this.vc.bind('seekstarted', function(e, d) {
			if (me.vc.isPaused()) {
				me.positionSlider(me.vc.toSegmentTime(d.to) / me.vc.duration());
			}
		});
		this.vc.bind('videoended', function(e, d) {
			d.duration && me.positionSlider(me.vc.toSegmentTime(d.end) / d.duration);
		});
		this.vc.bind('progress',function(e,d) {
			me.updateProgress(d.progress);
		});
		this.vc.bind('multi_progress',function(e,d){
			me._use_multi_progress = true;
			me.updateMultiProgress(d);
		});
		this.vc.bind('durationavailable',function(e,d) {
			me.createSegments(captions,d.duration)
		});
		return this;
	},
	updateProgress: function(progress) {
		if(progress > this.last_progress) {
			if(progress > .99) {
				progress = 1;
			}
			this.$e.find('.progress').eq(0).css({ width: progress * 100 + '%' });
			this.last_progress = progress;
		}

	},
	updateMultiProgress: function(obj) {
		var b = obj.buffer;
		var d = obj.duration;
		var $elems = this.$track.find('.progress');
		if($elems.length < b.length) {
			for(var i = $elems.length;i<b.length;i++) {
				$('<div class="progress">').appendTo(this.$track);
			}
		} else if ($elems.length > b.length) {
			$elems.slice(b.length).remove();
		}
		$elems = this.$track.find('.progress');
		for(var i = 0; i<b.length;i++) {
			var width = (b.end(i) - b.start(i)) /d;
			$elems.eq(i).css({width: (width*100)+'%', left: (b.start(i)/d*100)+'%' });
		}
	},
	createSegments: function(captions,duration) {

		if(this._segments_created)
			return;
		var me = this;
		var event_name = 'click';
		var $segment_wrap = $('<div />').addClass('segment_wrap');
		//var s = (new Date()).getTime();
		var temp = [];

		// this can be quite slow, hence the performance hacking
		for(var k = 0;k<captions.length;k++) {
			var v = captions[k];
			var ti = this.vc.toSegmentTime(v.time_in);
			var to = v.time_out==0 ? duration : this.vc.toSegmentTime(v.time_out);
			var l = ti/duration;
			var w = (Math.min(to,duration)-ti)/duration;
			w = Math.min(w,1-l); // w+l must be <= 1

			temp.push(
				$( document.createElement('span') )
				.addClass('segment')
				.attr('title','Subtitle ' + (parseInt(k)+1) )
				.css({
					width: w * 100 + '%',
					left: l * 100 + '%'
				}).data('caption_index',k)
			);
		}
		$segment_wrap.append(temp)
		$segment_wrap.prependTo(this.$e.find('.segments'))

		this.$e.find('.segments').on('click',function(e) {
				
				e.preventDefault();
				var $t = $(e.target);
				if($t.hasClass('segment')) {
					me.vc.seekToCaption($t.data('caption_index'));
				} else {
					me.vc.seekToPercent( ( e.pageX - $(this).offset().left ) / $(this).width() );
				}
				
			}
		);
		if ('ontouchstart' in window) {
			this.setupTouchDragging(); 
		} else {
			//this.$e.find('.touch_hit_target').hide();
		}

		this._segments_created = true;
	},
	setupTouchDragging: function() {
		var me = this;
		var was_paused,dims,last_segment,$segs = this.$e.find('.segment'),last_pct;
		function getDimensions() {
			return {
				sw:me.$touch_scrubber.outerWidth(),
				sl:me.$touch_scrubber.offset().left,
				tw:me.$e.width(),
				tl:me.$e.offset().left
			}
		}
		function positionData(page_x) {
			var left = $.clamp(page_x-dims.tl-dims.sw/2,0,dims.tw-dims.sw);
			var pct = left / (dims.tw-dims.sw);
			var caption_index = me.vc.captions.getCaptionIndexFromTime(me.vc.toVideoTime(pct * me.vc.duration()));
			return {
				left: left,
				pct: pct,
				caption_index: caption_index
			}
		}
		this.$e.on('touchstart',function(e){
			e.preventDefault();
			dims = getDimensions();
			was_paused = me.vc.isPaused();

			me.vc.pause();
			var d = positionData( e.originalEvent.touches[0].pageX );
			
			$segs.removeClass('highlight')
			if(d.caption_index !== null) {
				last_segment = $segs.eq( d.caption_index ).addClass('highlight');
			} else {
				last_segment = null;
				last_pct = d.pct;
			}
			me.$touch_scrubber
				.show()
				.css({transform: 'translateX(' + d.left +  'px)' });
		}).on('touchmove',function(e) {
			e.preventDefault();
			var d = positionData( e.originalEvent.touches[0].pageX );
			me.$touch_scrubber.css({transform: 'translateX(' + d.left +  'px)' });
			last_segment && last_segment.removeClass('highlight')
			if(d.caption_index !== null) {
				last_segment = $segs.eq( d.caption_index ).addClass('highlight');
			} else {
				last_segment = null;
				last_pct = d.pct;
			}
			
		}).on('touchend touchcancel',function(e){
			e.preventDefault();
			if(last_segment) {
				me.vc.seekTo( me.vc.captions[ last_segment.data('caption_index') ].time_in );
			} else {
				me.vc.seekToPercent( last_pct );
			}
			$segs.removeClass('highlight');
			last_segment = last_pct = null;
			if(!was_paused) {
				me.vc.play();
			} 
			me.$touch_scrubber.hide()
		});
	},
	positionSlider: function(percent) {
		if(!this.dragging) {
			var w = this.$e.find('.track').width();
			var pct = (w - this.$scrubber.width()) / w * 100 * percent + '%';
			this.$scrubber.css( { left: pct } );
		}
	}

});

function PlaybackControls(vc,captions,infopanel, app) {
	this.init(vc,captions,infopanel, app);
}
$.extend(PlaybackControls.prototype,{
	init: function(vc,captions,infopanel, app) {
		this.$e = $('body');
		this.app = app;
		this.vc = vc;
		var me = this;
		// the clickevent require a hard tap... buttons sould work with 
		// a quick repetitive taps.
		var event_name = 'touchend click';
		this.$e.find('.play').on(event_name,function(e){
			e.preventDefault();
			vc.togglePlay();
		});
		this.$e.find('.skip').on(event_name,function(e){
			e.preventDefault();
			vc.skip();
		});
		this.$e.find('.back').on(event_name,function(e){
			e.preventDefault();
			vc.back();
		});
		this.$e.find('.slow').on(event_name,function(e){
			e.preventDefault();
			vc[$(this).hasClass('active') ? "fast" : "slow"](); 
		});
		this.$e.find('.loop').on(event_name,function(e){
			e.preventDefault();
			vc[$(this).hasClass('active') ? "endCaptionLoop" : "startCaptionLoop"]();
		});
		this.$e.find('.fullscreen').on(event_name,function(e){
			e.preventDefault();
			!me.app.is_fullscreen ? me.app.enterFullscreen() : me.app.exitFullscreen();
		});
		this.app.bind('fullscreenchange',function() {
			me.app.is_fullscreen ?
				me.$e.find('.fullscreen').addClass('active') :
				me.$e.find('.fullscreen').removeClass('active');
				
		});
		
		this.$e.find('.caption_count').text(captions.length);
		vc.bind('captionchange',function(e,d) {
			me.$e.find('.caption_position').text(
				d.caption_index || d.caption_index === 0 ? d.caption_index+1 : '-'
			);
		});
		this.$e.find('.caption_count').text(captions.length);
		vc.bind('ratechange',function(e,d) {
			if(d.rate >= 1)
				me.$e.find('.slow').removeClass('active');
			else 
				me.$e.find('.slow').addClass('active');
		});
		vc.bind('playstatechange',function(e) {
			me.$e.find('.play').html(vc.isPaused() ? 'Play <span class="fa fa-fw fa-play"></span>' : 'Pause <span class="fa fa-fw fa-pause"></span>');
		});
		vc.bind('loopchange',function(e,d) {
			me.$e.find('.loop')[d.loop ? 'addClass' : 'removeClass']('active');
		});
	}, 
	onVideoGesture: function(gesture) {
		if(gesture=="clickLeft" || gesture == "swipeLeft") {
			this.vc.back();
			$('#back_overlay').show().fadeOut(300);
		} else if (gesture == "clickRight" || gesture == "swipeRight") {
			this.vc.skip();
			$('#skip_overlay').show().fadeOut(300);
		} else {  // clickMiddle 
			if(this.vc.isPaused()) {
				this.vc.play();
				$('#play_overlay').show().fadeOut(500);
			} else {
				this.vc.pause();
				$('#pause_overlay').show().fadeOut(500);
			}
		}
	},
	handleKey:function (keyCode,event) {
		var $elem;
		if(keyCode == 37) { // left
			$elem = this.$e.find('.back');
		} else if (keyCode == 39) { // right
			$elem = this.$e.find('.skip');
		} else if (keyCode == 32) { // space 
			$elem = this.$e.find('.play');
		} else if (keyCode == 40) { // down
			$elem = this.$e.find('.slow');
		} else if (keyCode == 38) { // up
			$elem = this.$e.find('.loop');
		} else if (keyCode == 188) { // comma
			$elem = $('.wrap .transcript.text').closest('.wrap').find('.toggle');
		} else if (keyCode == 190) {
			$elem = $('.wrap .translation').closest('.wrap').find('.toggle');
		}

		if($elem) {
			event.preventDefault();
			$elem.click().addClass('pressed') && 
			setTimeout(function() {
				$elem.removeClass('pressed')
			},100);
		}
	
	}
});

function VideoClickController(vc,getDelegate) {
	this.init(vc,getDelegate);
}
$.extend(VideoClickController.prototype, {
	init: function(vc,getDelegate) {
		var me = this;

		var start_touch_x;
		var diag_inches_estimate = /(phone|mobile)/i.test(navigator.userAgent) ? 5 : 8;
		function approxPxToCentimeters(px) {
			var bh = $('body').outerHeight(); 
			var bw = $('body').outerWidth();
			var diag_pixels = Math.sqrt(bh*bh + bw*bw);
			var ppi = diag_pixels / diag_inches_estimate;

			return px / ppi * 2.54;
		}

		var $allowed_list = vc.$e.find('video,img,#ipad_start_tip').andSelf();  // ignore clicks / touches on captions;
		function doIgnoreEvent(e) {
			return ! ($allowed_list.index(e.target) >= 0) || $('#fsd:visible').length;  // hack, but if the full screen dictionary is visib
		}
		
		function videoInEndState() {
			// within 1 second of the end of the video, is reliable;
			return (vc.currentTime() >= vc.duration() - 1);
		}
		function doAction(gesture) {
			var delegate = getDelegate();
			delegate && delegate.onVideoGesture && delegate.onVideoGesture(gesture)

		}
		function doActionForPct(pct) {
			if(pct < .22) {
				doAction("clickLeft");
			} else if (pct > .84) {
				doAction("clickRight");
			} else {
				doAction("clickCenter");
			}
		}
		vc.$e.on('click',function(e) {
			if( doIgnoreEvent(e) ) {
				return;
			}
			e.preventDefault();
			var pct = (e.pageX - $(this).offset().left) / $(this).width();
			doActionForPct(pct);
		}).on('touchstart',function(e){
			var oe = e.originalEvent;
			if(oe.touches.length == 1 && !videoInEndState() ) { // dont break zoom, otherwise a double tap can get the user stuck
				oe.preventDefault();
			}
			start_touch_x = oe.touches[0].pageX;
		}).on('touchend',function(e){
			if( doIgnoreEvent(e) ) {
				return;
			}
			var oe = e.originalEvent;
			var end_x = oe.changedTouches[0].pageX
			var dx = end_x - start_touch_x;
			var cm = approxPxToCentimeters(dx);

			if(Math.abs(cm) > .5) {
				if(dx < 0) {
					doAction("swipeLeft");
				} else {
					doAction("swipeRight")
				}
			} else {
				var pct = (end_x - vc.$e.offset().left ) / vc.$e.width();
				doActionForPct(pct);
			}
			
		});
		
	}
});

function VideoEndDisplay(vc,caption_display,app) {
	this.init(vc,caption_display,app);
}
$.extend(VideoEndDisplay.prototype, {
	init: function(vc,caption_display,app) {
		var me = this;
		this.auto_jump_to_next = false;  // this is driven by a URL parameter -> &play_through=1
		this.$e = $('#video_end_overlay');
		this.app = app;

		this.$e.find('.repeat_forever').on('click',function(e){
			e.preventDefault();
			vc.setLoopForever(true);
		});
		
		this.$e.find('a.next_segment, .demo_item').on('click',function(e) {
			e.preventDefault();
			var target_media_id = $(this).data('media_id');
			var new_url = queryStringApply(
				window.location.href,
				{id:target_media_id},
				me.persistStateObject(vc,caption_display,app),   // this preserves slow/fullscreen/etc
				{time:null}
			); 
			window.location.replace( new_url );

		});
		
		// Thumbs up, Thumbs down.
		this.$e.on('click','.like_video, .dislike_video',function(e){
			e.preventDefault();
			var media_id = MEDIA_ID;
			var was_active = $(this).hasClass('active');
			var like_click = $(this).hasClass('like_video');
			var rating = 0;
			$(this).closest('.like_buttons').find('.like_video, .dislike_video').removeClass('active');
			if(!was_active) {
				$(this).addClass('active');
				rating = like_click ? 1 : -1;
			}
			$.post('/services/videos_ajax.php',{ action:'vote', rating: rating, media_id: media_id },function(){
				// do nothing
			});
		});
		vc.bind('videoended',function() {
			if(!app.currentGameType && !vc.getLoopForever()) {
				
				if(me.auto_jump_to_next) { // if the url has play_through=1, then we shouldn't wait to play next segment.
					me.$e.find('a.next_segment').click();
				}

				me.show(vc,true);
				$(window).on('resize.yy',function(){
					me.show(vc,false);
				});

				setTimeout(function (){
					$(vc).on('playstatechange.yy seekstarted.yy play.yy',function(){
						me.dismiss(vc);
						$(vc).off('seekstarted.yy play.yy playstatechange.yy');
						$(window).off('resize.yy');
					});

				},100)
				
			}
		});
	},
	persistStateObject: function(vc,caption_display,app) {

		return {
			slow: vc.isSlow() ? 1 : null,
			fullscreen: app.is_fullscreen ? 1 : null,
			play_through: this.auto_jump_to_next ? 1 : null,
			hide_text: caption_display.getCurrentHideCode()
		};

	},
	addListeners: function(vc) {
		var $x = $('#video_wrap').find('.replay_image, video').on('click.ve',function(e){
			e.preventDefault();
			e.stopPropagation();
			vc.seekTo(vc.videoRange.start);
			vc.play();

		})
	},
	removeListeners: function() {
		$('#video_wrap').find('.replay_image, video').off('click.ve');
	},
	dismiss: function(vc) {
		$('body').removeClass('videoEndState');
		this.removeListeners();
		vc.resizeVideo();
		this.$e.fadeOut();
		vc._atVideoEnd = false;  // holy shit this the wrong place, but it fixes a bug.
		this.is_showing = false;
		clearInterval(this.countdown_timer_id);
	},
	show: function(vc,animated) {
		// measure 
		this.is_showing = true;
		var animation_duration = animated ? 400 : 0;
		var sizes = {
			min_vertical_padding: 50,
			min_horizontal_padding: 30,
			horizontal_spacing: 30,
			element_width: this.$e.find('.end_right').outerWidth(),
			cont_width: $('#video_container').width(),
			cont_height: $('#video_container').height()
		}

		var video_box = {
			max_width: sizes.cont_width - sizes.min_horizontal_padding * 2 - sizes.horizontal_spacing - sizes.element_width,
			max_height: sizes.cont_height - sizes.min_vertical_padding *2
		}
		var video_size = {
			width: Math.min(video_box.max_width, vc.nativeWidth() / vc.nativeHeight() * video_box.max_height),
			height: Math.min(video_box.max_height, vc.nativeHeight() / vc.nativeWidth() * video_box.max_width)
		}
		var video_left = (sizes.cont_width - video_size.width - sizes.horizontal_spacing - sizes.element_width) /2;
		var video_top = (sizes.cont_height - video_size.height) /2;
		var element_left = video_left + video_size.width + sizes.horizontal_spacing;
		var me = this;
		var $e_right = this.$e.show().find('.end_right');
		var element_top = Math.max(Math.min(video_top, (sizes.cont_height - $e_right.height()) /2),0);
		
		// then cut
		$('body').addClass('videoEndState');
		this.addListeners(vc);
		if(animated) {
			this.$e.find('.replay_image').hide();
		}
		vc.animateVideoSize({
			left: video_left,
			top: video_top,
			width: video_size.width,
			height:video_size.height
		}, animation_duration, function(){
			// position the replay image
			me.$e.find('.replay_image').css({
				left: video_left + video_size.width / 2 - 64,
				top: video_top + video_size.height/2 - 64 }).fadeIn(animation_duration);
		});
		this.$e.find('.end_right')
			.css({ opacity:.6, left: element_left + 20, top: element_top, maxHeight:sizes.cont_height })
			.animate({ opacity:1, left: element_left },animation_duration);

		if(this.$e.find('a.next_segment').length) {
			this.startCountdown();
		}
	},
	startCountdown: function() {
		var seconds = 10;
		var $countdown = this.$e.find('.countdown_secs').text(seconds);
		var $countdown_block = this.$e.find('.countdown').show();
		var me = this;
		(function cd() {
			me.countdown_timer_id = setTimeout(function(){
				seconds--;
				$countdown.text(seconds);
				if(seconds == 0) {
					if(me.is_showing && me.app.window_is_active_tab ) {
						me.$e.find('a.next_segment').click();
					} else {
						$countdown_block.hide();
					}
				} else {
					cd();
				}
			},1000);
		})();
	}
});

function LoadingSpinner(vc) {
	this.init(vc);
}
$.extend(LoadingSpinner.prototype, {
	init: function(vc) {
		vc.bind('loadingfinished',function() {
			$('#loading_spinner').hide();
		});
	}
});


/* ***************************************************
 *
 * Other non-game interface elements
 *
 * **************************************************/

function CaptionDisplay(vc,captions,info_panel,modal_dict, app){
	this.init(vc,captions,info_panel,modal_dict, app);
}
$.extend(CaptionDisplay.prototype,{
	init: function(vc,captions,info_panel,modal_dict, app) {
		this.vc = vc;
		this.captions = captions;
		this.modal_dict = modal_dict;
		this.app = app
		var me = this;
		this.info_panel= info_panel;

		this.buildCaptionDomElements(captions);
		this.$e = $('#captions');
		
		vc.bind('captionchange',$.proxy(this.displayCaptionIndex,this));
		if('ontouchstart' in window) { this.bindTouchEvents() };

		$('.transcript.text').addClass(this.app.opts.media_lang_id);
		$('.translation.text').addClass(this.app.opts.translation_lang_id);

		this.$e.find('.transcript, .translation, .romanization, .combined').on('click','.word',function(e) {
			e.preventDefault();
			var $t = $(this)
			if( $t.hasClass('active') ) {
				$t.closest('#captions').find('.word.active').removeClass('active');
				vc.play();
				modal_dict.hide();
			} else {
				$t.closest('#captions').find('.word.active').removeClass('active');
				$t.addClass('active');
				vc.pause();
			}
		});
		if(this.app.opts.media_lang_id == 'zh_CN') {
			$('.romanization, .combined').addClass('zh_CN_US').closest('.wrap').show();
		}

		function highlightLookups(container,lookup) {
			$(container).find('.word').filter(function(){ 
				return $(this).data('lookup') == lookup; 
			}).addClass('active');
		}
		
		$('#captions').on('click','.word',function(e) {
			e.preventDefault();
			e.stopPropagation();
			var $word = $(this);
			if(!$word.hasClass('active')) 
				return;
			me.sendToDict($word);

			var d_lookup = $word.data('lookup');
			d_lookup && highlightLookups(e.delegateTarget,d_lookup);
			
		});
		if(this.app.opts.media_lang_id == this.app.opts.translation_lang_id) {
			$('.translation').closest('.wrap').hide();
		}

		// chinese mode.  Not relevant if there is not a romanization
		this.$e.find('.do_combine').click(function(){
			$('.romanization, .transcript').closest('.wrap').hide();
			$('.combined').closest('.wrap').show();
			localStorageWrap.setItem("prefer_split","");
			me.app.resize();
		});
		this.$e.find('.do_split').click(function(){
			$('.romanization, .transcript').closest('.wrap').show();
			$('.combined').closest('.wrap').hide();
			localStorageWrap.setItem("prefer_split","yes");
			me.app.resize();
		});

		if(this.app.opts.media_lang_id == 'zh_CN') {
			if(localStorageWrap.getItem("prefer_split")) {
				this.$e.find('.do_split').click();
			} else {
				this.$e.find('.do_combine').click();
			}		
		}

		var me = this;
		this.$e.find('.toggle').on('click touchend',function(e) {
			e.preventDefault();
			var $el = $(this);
			me.toggle($el);
		});

		if(captions.length && !captions[0].translation) {
			this.$e.find('.translation').closest('.wrap').hide();
			this.app.resize();
		}
		if(this.app.opts.disable_translations || this.app.opts.captions_disabled) {
			this.$e.find('.translation').closest('.wrap').hide()
				.after('<div class="translations_disabled">Translations have been disabled by your teacher.</div>');
			this.app.resize();
		}
		if(this.app.opts.captions_disabled) {
			this.$e.find('.transcript').closest('.wrap').hide()
				.after('<div class="translations_disabled">Subtitles have been disabled by your teacher.</div>');

			if(this.app.opts.media_lang_id.substr(0,2) == 'zh') {
				this.$e.find('.romanization, .combined').parents('.wrap').hide();
			}
			this.app.resize();
		}
		this.app.bind('fullscreenchange',function(){
			if(me.app.is_fullscreen) {
				var vch = $('#video_container').outerHeight();
				var target_font_size = Math.max(vch/25,13);
				this.$e.find('.wrap').css('font-size',target_font_size);
			} else {
				this.$e.find('.wrap').css('font-size','');
			}
		});

	},
	toggle: function($el,only_hide) {
		if (!$el.hasClass('toggle'))
			return;

		var $p = $el.closest('.wrap');
		if( !$el.hasClass('off') ) {
			$p.css('height',$el.outerHeight()).find('.text').hide();
			$el.addClass('off');
		} else if(!only_hide) {
			$p.css('height','').find('.text').show();
			$el.removeClass('off');
		}
		this.app.resize();
	},
	hideByCode: function(code) {  
		// code is comma separated 
		// where all means 'n,t,r,c' (native, translation, romanization, combined)
		if(!code) return;
		var parts = code.split(',');
		var map = { 
			n: 'transcript',
			t: 'translation',
			r: 'romanization',
			c: 'combined'
		}
		var me = this;
		parts.forEach(function(val) {
			var key = map[val];
			if(key) {
				var $toggle_el = me.$e.find('.' + key).closest('.wrap').find('.toggle');
				me.toggle($toggle_el,true);
			}
		});
	},
	getCurrentHideCode: function() {
		var map = { 
			'transcript': 'n',
			'translation': 't',
			'romanization': 'r',
			'combined': 'c',
		}
		var codes = [];
		for(var key in map) if (map.hasOwnProperty(key)) {
			var code = map[key];
			if( this.$e.find('.' + key).closest('.wrap').find('.toggle').hasClass('off') ) {
				codes.push(code);
			}
		}
		if(codes.length) {
			return codes.join(',');
		}
		return null;
	},	
	hideAll: function() {
		var $toggles = $('.toggle');
		$toggles.each(function() {
			var $el = $(this);
			$el.closest('.wrap').css('height', $el.outerHeight()).find('.text').hide();
			$el.addClass('off');
		});
		this.app.resize();
	},
	showAll: function() {
		var $toggles = $('.toggle');
		$toggles.each(function() {
			var $el = $(this);
			$el.closest('.wrap').css('height','').find('.text').show();
			$el.removeClass('off');
		});
		this.app.resize();
	},
	sendToDict: function($word) {
		if(!$word || !$word.length) {
			return;
		}
		var is_reverse = !!$word.closest('.translation').length;
		var lookup_value = $word.data('lookup') || $word.text();
		if(this.app.is_fullscreen || !$('#right_col').is(':visible')) {
			this.modal_dict.lookup({
				word: lookup_value,
				caption_id: this.captions[this.vc.current_caption].id,
				elem: $word,
				word_lang_id: is_reverse ? this.app.opts.translation_lang_id : this.app.opts.media_lang_id,
				output_lang_id: is_reverse ?  this.app.opts.media_lang_id : this.app.opts.translation_lang_id
			});
		} else {
			this.info_panel[is_reverse ? 'lookupWordReverse' : 'lookupWord'](lookup_value,this.captions[this.vc.current_caption].id);
		}
	},
	displayCaptionIndex: function(e,d) {
		var i = d.caption_index;
		if(i !== null && i !== undefined) {
			this.$e.find('.transcript.text').html(this.$captions[i].$transcript);
			this.$e.find('.translation').html(this.$captions[i].$translation);
			this.$e.find('.romanization').html(this.$captions[i].$romanization);
			this.$e.find('.combined').html(this.$captions[i].$combined);
			this.$e.find('.active').removeClass('active');
		} else {
			this.$e.find('.transcript.text').text('');
			this.$e.find('.translation').text('');
			this.$e.find('.romanization').text('');
			this.$e.find('.combined').text('');
		}
	},
	bindTouchEvents: function() {

		var hit_targets,me = this;
		var oversize_y = 40, oversize_x = 10;
		function captureBoxes($e) {
			hit_targets = [];
			$e.find('.word').each(function(){
				var $word = $(this);
				var w = $word.outerWidth(), h = $word.outerHeight();
				var o = $word.offset();
				hit_targets.push({
					top: o.top - oversize_y,
					bottom: o.top + h + oversize_y,
					left: o.left - oversize_x,
					right: o.left + w + oversize_x,
					center_x: o.left + w/2,
					center_y: o.top + h/2,
					$el: $word
				});
			});
		}
		var $none = $('');
		function elForTouch(touch) {
			var px = touch.pageX, py = touch.pageY;
			var candidates = [];
			for(var i = 0;i<hit_targets.length;i++) {
				var box = hit_targets[i]
				if(px >= box.left && px <= box.right && py >= box.top && py <= box.bottom) {
					candidates.push(box);
				}
			}
			if(!candidates.length)
				return $none;
			if(candidates.length == 1)
				return candidates[0].$el
			candidates.sort(function(a,b) { 
				// manhattan distance is good enough and faster
				var dist_a = Math.abs(a.center_x - px) + Math.abs(a.center_y - py);
				var dist_b = Math.abs(b.center_x - px) + Math.abs(b.center_y - py);
				return dist_a - dist_b;
			});
			return candidates[0].$el;
			

		}
		var $word_indicator = $('#caption_touch_indicator'), 
			$word_placeholder = $('#caption_touch_placeholder');
		function showWordIndicator($el,word) {
			$word_placeholder.text(word);
			$word_indicator.show();
			var w = $word_indicator.outerWidth(), h = $word_indicator.outerHeight();
			var o = $el.offset();
			var ow = $el.outerWidth();
			var vertical_offset = me.app.device.is_phone ? 20 : 10; // smaller screens need more offset to not have the finger cover the word;
			$word_indicator.css({ left: o.left +ow/2 - w/2 , top: o.top - h - vertical_offset });
		}
		var was_playing,$last_el = $none;
		$('#captions').on('touchstart',function(e) {
			var $this = $(this);
			var oe = e.originalEvent;
			oe.preventDefault();
			was_playing = !me.vc.isPaused();
			me.vc.pause();
			captureBoxes( $this );
			var $el = elForTouch(oe.touches[0]);
			if($el != $last_el) {
				$last_el.removeClass('hover');
				$el.addClass('hover')
				var text = $el.data('lookup') || $el.text();
				$last_el = $el;
				$el.length ? showWordIndicator($el,text) : $word_indicator.hide();
			}
		}).on('touchmove',function(e) {
			var oe = e.originalEvent;
			oe.preventDefault();

			var $this = $(this);
			var $el = elForTouch(oe.touches[0]);
			$this.find('.word').removeClass('hover');
			$el.addClass('hover');
			if($el != $last_el) {
				$last_el.removeClass('hover');
				$el.addClass('hover')
				var text = $el.data('lookup') || $el.text();
				$last_el = $el;
				$el.length ? showWordIndicator($el,text) : $word_indicator.hide();
			}

		}).on('touchend touchcancel',function(e) {
			var oe = e.originalEvent;
			oe.preventDefault();
			oe.stopPropagation();
			$(this).find('.word').removeClass('hover');
			$word_indicator.hide();
			if($last_el.length) {
				me.sendToDict($last_el);
			} else {
				was_playing && me.vc.play();
			}
		});
	},
	buildCaptionDomElements: function(c) {
		this.$captions = [];
		var sep = this.app.opts.media_lang_id == 'zh_CN' ? '' : ' ';
		
		for(var i = 0;i<c.length;i++) {
			var transcript = "";
			for(var j =0;j<c[i].transcript_words.length;j++) {
				transcript +=  ''
					+ c[i].transcript_words[j]['pre']
					+ '<span class="word" data-lookup="' + (c[i].transcript_words[j]['lookup'] || '') + '">' + c[i].transcript_words[j]['word'] + '</span>'
					+ c[i].transcript_words[j]['post'] + sep;
			}
			var translation = "";
			if(c[i].translation_words) for(var j =0;j<c[i].translation_words.length;j++) {
				translation +=  ''
					+ c[i].translation_words[j]['pre']
					+ '<span class="word" data-lookup="' + (c[i].translation_words[j]['lookup'] || '') + '">' + c[i].translation_words[j]['word'] + '</span>'
					+ c[i].translation_words[j]['post'] + ' ';
			}
			var romanization = "";
			if(c[i].romanization_words) for (var j =0;j<c[i].romanization_words.length;j++) {
				romanization +=  ''
					+ c[i].romanization_words[j]['pre']
					+ '<span class="word" data-lookup="' + (c[i].romanization_words[j]['lookup'] || '') + '">' + c[i].romanization_words[j]['word'] + '</span>'
					+ c[i].romanization_words[j]['post'] + ' ';
			}
			var combined = "";
			if(c[i].romanization_words) for (var j =0;j<c[i].romanization_words.length;j++) {
				var tw = c[i].transcript_words[j];
				var rw = c[i].romanization_words[j];
				tw.post = $.trim(tw.post);
				tw.pre = $.trim(tw.pre);
				
				combined +=  '<span class="word_block word" data-lookup="' + tw.word + '" >'
					+ '<span class="top '+ (tw.post ? 'pull_right' :'') + '">' + tw.pre + tw.word + tw.post + '</span>'
					+ '<br>'
					+ '<span class="bottom">' + rw.pre + rw.word + rw.post + '</span>'
					+ '</span>';
			}
			
			this.$captions[i] = {
				$transcript: $('<div><span class="caption_bar">' + transcript + '</span></div>'),
				$translation: $('<div><span class="caption_bar">' + translation + '</span></div>')
			}
			if(romanization) {
				this.$captions[i].$romanization = $('<div><span class="caption_bar">' + romanization + '</span></div>')
				this.$captions[i].$combined = $('<div><span class="caption_bar">' + combined + '</span></div>');
			}

		}
		
	}
});

function InfoPanel(opts,device) {
	this.init(opts,device);
}
$.extend(InfoPanel.prototype,{
	init: function(opts,device) {
		this.opts = opts;
		this.device = device;
		this.$e = $('#dictionary');
		var me = this;
		this.$e.find('form').submit($.proxy(this.submitHandler,this));
		this.$e.find('a.search').click(function(e){
			e.preventDefault();
			$(this).closest('form').submit();
		});
		this.$e.find('form.normal').find('label')
			.text(
				this.opts.media_lang_name +
				' » ' + this.opts.translation_lang_name)
		this.$e.find('form.reverse').find('label')
			.text(
				this.opts.translation_lang_name +
				' » ' + this.opts.media_lang_name)

		if(this.opts.media_lang_id == this.opts.translation_lang_id) {
			$('#lookup_reverse').closest('.search_block').hide();
		}


		if(localStorageWrap.getItem("do_not_auto_save_flashcard") == 'true') {
			this.$e.find('#do_add_to_word_list').prop('checked',false);
		} else {
			this.$e.find('#do_add_to_word_list').prop('checked',true);
		}


		this.$e.find('#lookup, #lookup_reverse').on('focus',function(){
			$(this).data('caption_id',null);
		});
		
		this.$e.find('#do_add_to_word_list').on('change',function(){
			var value = 'true';
			if($(this).is(':checked')) {
				me.$e.find('.add_to_word_list button').hide();
				value = '';
			} 
			localStorageWrap.setItem("do_not_auto_save_flashcard",value);
			
		}).trigger('change');
		this.$e.find('.add_to_word_list button').on('click touchstart',function(e){
			me.addToFlashCards();
			return false;
		}).hide();
	},
	lookupWord: function(word,caption_id) {
		this.$e.find('#lookup_reverse').val('');
		this.$e.find('#lookup').val(word).data('caption_id',caption_id).closest('form').submit();
	},
	lookupWordReverse: function(word,caption_id) {
		this.$e.find('#lookup').val('');
		this.$e.find('#lookup_reverse').val(word).data('caption_id',caption_id).closest('form').submit();
	},
	shouldAutoSave: function() {
		var checked = this.$e.find('#do_add_to_word_list:checked').length;
		var exists = this.$e.find('#do_add_to_word_list').length;
		return !exists || checked;
	},
	addToFlashCards: function() {
		var params = $.extend({},this.params);
		params.action = 'add_to_flashcards';
		params.skip_flashcards = false;
		var me = this;
		$.post('player_service.php',params,function(){
			me.$e.find('.add_to_word_list button').fadeOut();
		});
	},
	submitHandler: function(e) {
		e.preventDefault();
		var $f = $(e.target);
		var l = [this.opts.media_lang_id,this.opts.translation_lang_id]
		var is_reverse = $f.hasClass('reverse');
		var me = this;
		var word = $f.find('input').val();
		var caption_id = $f.find('input').data('caption_id');
		var xhr;
		if(this.word != word) {
			this.word = word;
			// if(this.xhr && this.xhr.readyState !=4 && this.xhr.abort) {
			// 	this.xhr.abort();
			// } 
			me.$e.find('.info_text').html('looking up <b>'+word+'</b>');
			me.params = {
				action: 'lookup',
				word: word,
				word_lang_id: is_reverse ? l[1] : l[0], 
				output_lang_id: is_reverse ? l[0] : l[1],
				caption_id: caption_id,
				skip_flashcards: (!this.shouldAutoSave() || is_reverse) ? '1' : ''
			};
			this.xhr = $.getJSON(
				'player_service.php',
				me.params,
				function(data) {
					if(data) {
						me.$e.find('input').val('');
						var $i = $f.find('input').val(data.word);
						if(me.device.is_touch) {
							 $i.blur(); 
						}
						if(!me.shouldAutoSave() && !is_reverse) {
							me.$e.find('.add_to_word_list .add_word_wrap').text(data.word);
							me.$e.find('.add_to_word_list button').show();
						}

						me.$e.find('.indicator').removeClass('active');
						$f.find('.indicator').addClass('active');
						me.$e.find('.info_text').html('<div class="dict_response">'+data.text+'</div>');
					}
				});
		}
		
		return false;
	}
});

function ModalDictionary() {
	this.init();
}
$.extend(ModalDictionary.prototype,{
	init:function() {
		this.$e = $('#fsd');
		this.$res = $('#fsd_result');
		this.$input = $('#fsd input');
		this.$pointer = $('#fsd_pointer');
		this.$spinner = $('#fsd_loading');
		this.half_pointer_width = this.$pointer.width()/2;
		var me = this;
		this.$e.find('form').submit(function(e){
			e.preventDefault();
			me.$input.blur();
			me.lookup({ word: me.$input.val(), word_lang_id: me.last_wl, output_lang_id: me.last_ol, elem: me.last_el });
		});

		this.$e.find('#fsd_outer').on('click touchend',function(e){
			e.stopPropagation();
		});
		this.$e.find('#fsd_close').on('click touchend',function(e){ 
			e.preventDefault(); 
			me.hide();
		});
		
	},
	show: function(){
		this.$e.show();
		var me = this;
		$(document).on('click.fsd touchend.fsd',function(){
			me.hide();
		});
		$(window).on('resize.fsd',function(){
			me.position(me.last_el);
		});
		
	},
	hide: function() {
		$(document).off('click.fsd touchend.fsd');
		$(window).off('resize.fsd');
		this.$e.hide();
	},
	showLoading: function() {
		this.$spinner.show();
		this.$res.css('color','#999');

	},
	endLoading:function() {
		this.$spinner.hide();
		this.$res.css('color','#333');
	},
	lookup:function(obj) {
		var me = this;
		this.$input.val(obj.word);
		this.showLoading();
		this.show();
		obj.elem && this.position(obj.elem);
		// this.xhr && this.xhr.abort();

		this.xhr = $.get('player_service.php',
			{
					action: 'lookup',
					word: obj.word,
					word_lang_id: obj.word_lang_id,
					output_lang_id: obj.output_lang_id,
					caption_id: obj.caption_id
			},
			function(data) {
				me.$input.val(data.word);
				me.$res.html( $('<div />').addClass('dict_response').html(data.text) );
				me.$res.scrollTop(0);
				obj.elem && me.position(obj.elem);
				
				me.endLoading();
				me.xhr = null;

			},
			'json'
		);
		this.last_ol = obj.output_lang_id;
		this.last_wl = obj.word_lang_id;
		this.last_el = obj.elem;

	},	
	position:function (el) {
		el = $(el);
		var e_pos = el.offset();
		var e_width = el.outerWidth();
		var ww = $(window).width();
		this.$e.find('#fsd_outer').css('max-width',ww);
		var this_width = this.$e.outerWidth();
		var this_height = this.$e.outerHeight();
		// center on word element, clamp to screen;
		var target_left = e_pos.left + e_width/2 - this_width/2;
		var actual_left = $.clamp(target_left,0,ww-this_width);
		var pointer_shift = target_left - actual_left;
		var pointer_left = this_width/2 - this.$pointer.outerWidth()/2 + pointer_shift;
		var target_top = e_pos.top - this_height;

		// handle case where it would be off screen;
		if(target_top < 0) {
			target_top = Math.max(target_top + 30,0);
			this.$pointer.css('visibility','hidden');
		} else {
			this.$pointer.css('visibility','visible');
		}
		this.$pointer.css({left:pointer_left});
		this.$e.css({ left: actual_left, top: target_top });
	}
});

function MiniKeyboard(t,$container,lang_id, onInsert) {
	this.init(t,$container,lang_id, onInsert);
}
$.extend(MiniKeyboard.prototype,{
	langs: {
		es:['á','é','í','ñ','ó','ú','ü'],						
		fr:['à','ä','â','æ','ç','é','è','ê','ë','î','ï','œ','ö','ô','ù','û','ü'],
		de:['ä','Ä','é','ö','Ö','ü','Ü','ß'],
		it:['à','è','é','ì','ò','ó','ù']
	},
	init: function(t,$container,lang_id, onInsert) {
		
		onInsert = onInsert || function() { };
		this.$target = $(t);
		this.$e = $('<div class="minikeyboard clearfix" />').appendTo($container);
		if(this.langs[lang_id])
			this.render(lang_id);
		
		var me = this;
		this.$e.find('a').click(function(e){
			e.preventDefault();
			e.stopPropagation();
			me.$target.focus();
			var range = me._insertAtCaret(me.$target[0],$(this).text() )
			onInsert(this.innerText, range);
			me.$target.trigger('input');
		});
	},
	render: function(lang_id) {
		
		var me = this;
		$.each(this.langs[lang_id],function(k,v) {
			
			$('<a href="#" class="key button"></a>').text(v).appendTo(me.$e);
		});
	},
	/* Some utility functions */
	_insertAtCaret: function(obj, text) {
		var start, end;
		if(document.selection) {
			obj.focus();
			var orig = obj.value.replace(/\r\n/g, "\n");
			var range = document.selection.createRange();
			start = range.startOffset;
			end = range.endOffset;

			if(range.parentElement() != obj) {
				return false;
			}

			range.text = text;
			var actual,tmp;
			actual = tmp = obj.value.replace(/\r\n/g, "\n");

			for(var diff = 0; diff < orig.length; diff++) {
				if(orig.charAt(diff) != actual.charAt(diff)) break;
			}

			for(var index = 0, start = 0;
				tmp.match(text)
					&& (tmp = tmp.replace(text, ""))
					&& index <= diff;
				index = start + text.length
			) {
				start = actual.indexOf(text, index);
			}
		} else if("selectionStart" in obj) {
			start = obj.selectionStart;
			end   = obj.selectionEnd;

			obj.value = obj.value.substr(0, start)
				+ text
				+ obj.value.substr(end, obj.value.length);
		}

		if(start != null) {
			this._setCaretTo(obj, start + text.length);
			return { from: start, to: end };
		} else {
			obj.value += text;
		}
	},
	_setCaretTo: function(obj, pos) {
		if(obj.createTextRange) {
			var range = obj.createTextRange();
			range.move('character', pos);
			range.select();
		} else if(obj.selectionStart) {
			obj.focus();
			obj.setSelectionRange(pos, pos);
		}
	}
});


/* ***************************************************
 *
 * Vocab Game Controller & View Elements
 *
 * **************************************************/
function GameController(vc, c, app,modalDict) { this.init(vc, c, app,modalDict); }
$.extend(GameController.prototype, {
	NUM_QUESTIONS:10,
	MAX_PRECEEDING_WHITESPACE: 2,
	WHITESPACE_PADDING: 1,
	INCORRECT_ACCENT_MESSAGE: TL_STRINGS.wrong_accent,
	score:0,
	question_index:-1,
	used_words: {},
	attempts_allowed: 3,
	attempts_remaining: null,
	
	init: function(vc,captions, app,modalDict) {
		this.vc = vc;
		this.captions = captions;
		this.app = app;
		this.modalDict = modalDict;
		this.$q = this.$e = $('#game_question');
		this.$input = $('#cloze_answer');
		this.$submit_answer = $('#submit_answer');
		this.$response = $('#response');
		this.$scoreboard = $('header.game_controls .scoreboard');

		var $qv = $('#question_view');
		for (var i=1 ; i <= this.NUM_QUESTIONS ; ++i) {
			$qv.append($('<span id="q'+i+'">').text(i));
		}
		var me = this;

		this.gameFinishedView = new ClozeGameFinishedView({
			numQuestions: this.NUM_QUESTIONS,
			onPlayAgain: function playAgain() {
				me.startNewGame(function() {
					me.gotoNextQuestion();
				});
			},
			onQuitGame: function() {
				me.app.exitGame();
			}
		});

		this.source_words_key = 'transcript_words';
		
		if(!(app.device.is_ipad || app.device.is_android || app.device.is_iphone)) {
			this.minikeyboard = new MiniKeyboard(
				this.$input,
				this.$e.find('.minikeyboard_container'),
				app.opts.media_lang_id);
		} else {
			this.$e.find('.minikeyboard_container').html(''
				+ '<div class="ipad_tip">'
				+ 'Tip:  hold down the letter to access accented characters'
				+ '</div>');
		}

		this.$q.find('.slow.button').on('click',function(e){
			e.preventDefault();
			me.vc.toggleSlow();
		});
		this.vc.bind('ratechange',function(e,d) {
			if(d.rate < 1) {
				me.$q.find('.slow.button').addClass('active');
				if(me.slow_used) {
					me.slow_used[me.round][me.question_index] = true;
				}
			} else {
				me.$q.find('.slow.button').removeClass('active');
			}
		});
	
		
		

		
		this.$q.find('.start_game').on('click touchend',function(e) {
			e.preventDefault();
			me.gotoNextQuestion();
		});
		this.$q.find('.repeat').on('click touchend',function(e) {
			e.preventDefault();
			me.vc.backNSeconds(3);
			me.vc.play();
		});

		this.$q.find('.replay.button').on('click touchend',function() {
			me.playCurrentQuestion();
			me.$response.hide();
		});
		this.$input.on('keydown',function(e) {
			if(e.which == 13) { // ENTER: submit answer (we use keydown because ie sucks)
				if(me.state == 'PENDING ANSWER')
					me.checkAnswer();
				else if (me.state == 'PENDING NEXT')
					me.gotoNextQuestion();
				return false;
			}
		});
		this.$submit_answer.on('click touchend',function() {
			me.checkAnswer();
			return false;
		});
		this.$input.on('keypress',function(e) {
			if (e.which == 32) { // SPACE: replay 
				e.preventDefault();
				$('.replay.button').click().addClass('pressed');
				setTimeout(function() {
					me.$q.find('.replay.button').removeClass('pressed')
					}, 100);
			} else {
				me.$input.removeClass('blank');  // this class gets added when someone tries to submit a blank answer.
			}
		}).on('paste',function(){
			me.paste_count++;
			return false;
		});
		this.$q.find('.next').on('click touchstart',function(e) {
			me.gotoNextQuestion();

			return false;
		});

		this.$q.on('click touchend','.game_word',function(e){
			e.preventDefault();
			e.stopPropagation();
			var lookup = $(this).data('lookup') || $(this).text();
			modalDict.lookup({
				elem: $(this),
				word: lookup,
				word_lang_id: app.opts.media_lang_id,
				output_lang_id: app.opts.translation_lang_id
			});
		});

		this.$q.find('.choice_buttons').on('click touchend','.button',function(){
			me.checkChoiceAnswer( $(this) );
		});
		
		$('.show_game_score_rules').on('click touchend',function(e) {
			e.preventDefault();
			e.stopPropagation();
			var o = $(this).offset();
			var $r = $('#game_score_rules').appendTo('body').css({ top:0,left:0 }).show();
			var base_l = o.left + $(this).outerWidth()/2 - $r.outerWidth()/2;
			var target_l = $.clamp(base_l,0,$('body').width()-$r.outerWidth());
			$r.css({  
				top: o.top - $r.outerHeight() - 5,
				left: target_l
			});
			$('body').on('click.sgsr touchend.sgsr',function() {
				$r.hide();
				$('body').off('sgsr');
			});
		});
		
		this.createScoreListeners();
		
		return this;
	},
	start: function(game_type,use_romanization) {
		this.game_type = game_type;  // 'cloze' or 'choice'

		if(app.opts.media_lang_id.substr(0,2) == 'zh') {
			this.use_romanization = use_romanization;
		}

		this.startNewGame();
		this.loadScoreHistory();
	},
	exit: function() {
		this.$response.hide();
		this.vc.endRangePlay();
		this.vc.seekTo(this.vc.toVideoTime(0.01));
		this.vc.pause();
	},
	onVideoGesture: function(gesture) {
		var $rpb = $('.replay.button:visible').addClass('pressed').click();
		setTimeout(function(){ $rpb.removeClass('pressed') },100);
	},
	startNewGame: function(onDone) {
		// cleanup scoreboard
		this.$scoreboard.find('#question_view span').removeClass('correct incorrect partial');
		$('#game_score_rules .cloze, #game_score_rules .choice').hide();
		$('#game_score_rules .'+this.game_type).show();

		this.paste_count = 0;  // cheat detection
		this.round = 1;
		this.score = 0;
		this.question_index = -1;
		this.$scoreboard.find('.points').text(0);
		this.response_data = [null,[],[] ];
		this.slow_used = [null,[],[] ];
		this.questions = [];


		
		this.vc.pause();
		this.vc.fast();
		this.vc.endCaptionLoop();
		
		this.state = 'PENDING START';
		var me = this;

		this.$q.find('.start_game').hide();
		this.$q.find('.loading').show();
		this.buildQuestions(function(){
			me.$q.find('.start_game').show();
			me.$q.find('.loading').hide();
			onDone && onDone();
		});

		this.showCurrentState();

		TrackEvent('game start');
		
		
	},
	gotoNextQuestion: function() {
		
		if(this.round==1) {
			if(this.question_index < this.NUM_QUESTIONS-1) {
				this.question_index++;	
			} else {
				this.question_index = -1;
				this.round=2;
				this._r2t = true;
			}
		}
		if(this.round == 2) {
			this.question_index++;
			this.question_index = this.getRound2NextStartingFrom(this.question_index);
			if(this.question_index==-1) {
				this.endGame();
				return;
			} else if(this._r2t) {
				this.trigger('round2_start')
			}
		}
		this._r2t = false;
		this.vc.fast();
		this.attempts_remaining = this.attempts_allowed;

		this.setCurrentQuestion();
		this.playCurrentQuestion();
		
		this.state = 'PENDING ANSWER';
		this.showCurrentState();
		!this.app.device.is_touch &&
			this.$input.focus();
	},
	checkChoiceAnswer: function($el) {
		if(this.state != 'PENDING ANSWER') {
			return;
		}
		this.vc.pause();
		var source, grading, response = $el.text();
		var points_earned = 0;
		var do_repeat = true;
		if($el.data('is_correct')) {
			$el.addClass('correct');
			points_earned += this.round == 1 ? 2 : 1;
			do_repeat = false;
			source = $el.text();
			grading = 'correct';
		} else {
			$el.addClass('wrong');
			grading = 'incorrect';
			$el.closest('.choice_buttons').find('.button').each(function(){
				if($(this).data('is_correct')) {
					$(this).addClass('correct');
					source = $(this).text();
				}
			});
		}

		this.score += points_earned;
		
		this.response_data[this.round][this.question_index] = {
			source: source, 
			response: response, 
			points:points_earned, 
			do_repeat:do_repeat,
			grading: grading
		};

		this.trigger('score_change',
			{ 
				score: this.score, 
				points_earned: points_earned,
				question_index: this.question_index,
				grading: grading,
				elem: $el,
				progress: this.gameProgressPct(),
			});

		this.state = 'PENDING NEXT';
		this.showCurrentState();
		var me = this;
		setTimeout(function(){
			me.gotoNextQuestion();
		}, grading == 'correct' ? 2000 : 3500);
	},
	checkAnswer: function() {
		var response = this.$input.val();
		var q = this.questions[this.question_index];
		var source = q.answer;
		if(response == "") {
			this.$input.addClass('blank');
			this.$input.focus();
			return;
		}
		if(this.state != 'PENDING ANSWER') {
			return;
		}
		
		this.attempts_remaining--;

		this.vc.pause();
		var points_earned=0;
		var s = new Scorer();
		var diff = s.diff_words(source,response);
		var grading;
		var do_repeat = true;
		var try_again = !diff.match && this.attempts_remaining;
		var is_first_attempt = this.attempts_remaining + 1 == this.attempts_allowed;
		var animation_ms = is_first_attempt ? 0 : 200;

		if(diff.match) {
			points_earned = this.round == 1 ? 10 : 6;
			grading = 'correct';
			this.setResponse(''
				+ '<span class="positive"><i class="fa fa-check-circle"></i> Correct!</span>',
				'success'
			);
			do_repeat = false;
		} else {
			points_earned = 0;
			grading = 'incorrect';
			var ta_label = diff.no_partial_match ? 'Try again' : 'Almost, try again';
			if(try_again) {
				this.setResponse(''
					+ '<span class="try_again">' + ta_label + '</span><br>'
					+ '<span class="response">' + diff.hint_markup + '</span> ');
			} else {
				this.setResponse(''
					+ '<span class="incorrect_header"><i class="fa fa-times-circle"></i> Incorrect</span><br/>'
					+ (this.round == 1 ? '<small class="round2_hint">Word will be repeated in Round 2.</small><br/>' : '')
					+ '<span class="source">'+ diff.source_markup + '</span> ' + TL_STRINGS.is_correct + '<br>'
					+ '<span class="response">' + diff.response_markup + '</span> ' + TL_STRINGS.is_incorrect,
					'fail' );
			}
		}
		if(this.slow_used[this.round][this.question_index]) {
			points_earned -= 1;
		}


		if(try_again) {
			if(diff.no_partial_match) {
				// correct start letters
				var rletters = response.split('');
				var sletters = source.split('');
				var start_string = "";
				for(var i = 0; i<rletters.length;i++ ) {
					if(sletters[i] && rletters[i].toLowerCase() == sletters[i].toLowerCase()) {
						start_string += sletters[i];
					} else {
						break;
					}
				}
				this.$input.val( start_string.length ? start_string : source.substr(0,1) );
			}
			this.$input.focus();
			this.showResponse(animation_ms);
			return;
		}
		
		var failed_attempts = this.attempts_allowed - this.attempts_remaining-1;
		points_earned -= failed_attempts * 2;

		points_earned = Math.max(points_earned,0);

		this.score += points_earned;
		
		this.response_data[this.round][this.question_index] = {
			source: source, 
			response: response, 
			grading:grading, 
			points:points_earned, 
			do_repeat:do_repeat 
		};

		this.trigger('score_change',
			{ 
				score: this.score, 
				points_earned: points_earned,
				question_index: this.question_index,
				grading: grading,
				elem: this.$input,
				progress: this.gameProgressPct()
			});

		var color = grading == 'correct' ? '#0A0' : (grading ==  'partial' ? '#C90' : '#A00');
		this.$input.css('color',color);
		this.$input.blur();

		this.state = 'PENDING NEXT';
		
		this.showCurrentState();
		this.showResponse(animation_ms);
	},
	setResponse: function(html,cls) {
		this.$response.html(html).removeClass().addClass(cls);
	},
	showResponse: function(animation_ms,cls) {

		var o = this.$input.offset();
		this.$response.appendTo('body').css({
			left: o.left-11,
			top: o.top - this.$response.outerHeight() - 5
		})
		if(animation_ms) {
			this.$response.hide().fadeIn(animation_ms);
		} else {
			this.$response.show();
		}
		
	},
	createScoreListeners: function() {
		var me = this;

		this.bind('score_change',function(e,d){
			
			var $el = $(d.elem);
			if(d.points_earned > 0) {
				var sf = $('<span class="score_flash">+'+d.points_earned+'</span>').appendTo('body');
				var w = sf.width();
				sf.css(
					{
						top: $el.offset().top,
						left: $el.offset().left - w - 4
					}
				)
				.animate({ top: '-=80', opacity: 0 },2000,function(){
					$('.score_flash').remove();
				})
			}
			// update the progress bar 
			me.$scoreboard.find('.progress_bar').animate({ width: d.progress +'%' },600);

			// count up to the correct total	(turbo tax style)
			var target = d.score;
			var to = 50;
			(function x() {
				var s = parseInt(me.$scoreboard.find('.points').text()) || 0;
				if (s < target) {
					me.$scoreboard.find('.points').text(s+1);
					setTimeout(x,to);
					to += 10;
				}
			})();
			
			// set the underline;
			me.$scoreboard.find('#q' + (d.question_index+1) ).addClass(d.grading);
		});
		this.bind('round2_start',function() {
			me.$q.append('<span class="round2_flash">Starting Round 2</span>')
			.find('.round2_flash')
			.animate({ top: '-=100', opacity: 0 },2000,function(){
				me.$q.find('.round2_flash').remove();
			})
			
		});
		
	},
	setCurrentQuestion: function() {

		this.$input.val('');
		var placeholder = '';
		var q = this.questions[this.question_index];
		// move the input around to maintain focus.
		this.$input.appendTo('.question_wrap');
		var $underline = this.$q.find('.question').html(q.text).find('.underline');
		if(this.game_type == 'cloze') {
			$underline.after( this.$input.show() ).hide();
		} else {
			this.$input.hide();
		}
		// measure the size of the correct response, and resize input;
		var w = $('<div id="test">').html(q.answer).appendTo('body').width();
		$('#test').remove();
		this.$input.css('width',(w + 22) + 'px').css('color','#000'	);
		
		// show a placeholder with appostrophe's and underscores, if the word has an apostrophe so: c'est becomes _'___
		if(q.answer.match(/['\-\.]/)) {
			// this doesn't work well on IE, because IE hides the placeholder on focus.
			placeholder = q.answer.replace(/[^'\-\.]/g,'_');

		}
		this.$input.attr('placeholder',placeholder);

		this.$scoreboard.find('#question_view span').removeClass('active')
			.end().find('#q'+(this.question_index +1)).addClass('active');
		this.$scoreboard.find('#round_view span').removeClass('active')
			.end().find('#r'+this.round).addClass('active');
		

		if(this.game_type == 'choice') {
			var els = this.buttonsForQuestion(q);
			var $bcont = this.$q.find('.choice_buttons').html(els);
	
		}
		
	},
	gameProgressPct: function() {
		var total = 0;
		var ROUNDS = 2;
		for(var r = 1; r <= ROUNDS; r++) {
			for(var j=0; j< this.NUM_QUESTIONS; j++) {
				if(this.response_data[r] && this.response_data[r][j]) {
					if(r == 1 && this.response_data[r][j].grading == 'correct') {
						total += 2;
					} else if (r == 1 && j <= this.question_index) {
						total++;
					} else {
						total +=1;
					}
				}
			}
			
		}

		return Math.round((total / this.NUM_QUESTIONS / ROUNDS)*100);
		
	},
	buttonsForQuestion: function(q) {
		return q.choices.map(function(v){
			return $('<button />').text(v.word).data('is_correct',v.is_correct).addClass('button');

		});
	},
	playCurrentQuestion: function() {
		var q = this.questions[this.question_index];
		this.vc.playRange(q.start_time,q.end_time);
	},
	endGame: function() {
		this.saveScore();
		this.state = 'GAME OVER';
		this.showCurrentState();
	},
	loadScoreHistory: function() {
		var me = this;
		$.getJSON(
			'player_service.php?',
			{ 
				action: 'score_history',
				media_id: this.app.opts.media_id,
				game_type: this.game_type
			},
			function(data) {
				if(data.success) {
					var html = data.total_points + ' All-time Points ';

					$('header.game_controls .score_history_link').html(html).off('click').on('click',function() {
						$('<div class="mask">').appendTo('body').on('click',function() {
							$(this).remove();
							$('#score_history_details').hide();
						});
						
						var w = $('#score_history_details').show().width();
						$('#score_history_details').css({
							left: ($(document).width() - w)/2,
							'max-height': $(window).height() -50
						});
					});
					
					html = '<h4>'+ data.total_points + ' Lifetime Total Points</h4>';
					for(var i= 0;i<data.data.length;i++) {
						var r = data.data[i];
						var d = new Date(r.date * 1000);
						html += '<div class="score_history_row">'  
							+ '<strong>' + r.score + '</strong>' 
							+ ' points earned on '
							+ ['Jan','Feb','Mar','Apr','May','Jun',
								'Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]
							+ ' ' + d.getDate() + ', ' + d.getFullYear() 
							+ ' at ' + ((d.getHours() % 12) || 12) + ':' 
							+ (d.getMinutes() < 10 ? '0': '') + d.getMinutes()
							+ (d.getHours() > 12 ? 'pm' : 'am')
							+ '</div>';
					}
					$('#score_history_details').html(html)
				} else {
					$('header.game_controls .score_history_link').html('');
				}
			});
	},
	saveScore: function() {
		var me = this;
		this.gameFinishedView.setSaveStatus('<div class="saving_indicator"><img src="/images/small-spinner-fb.gif" width=22 height=15 /> Saving score...</div>');
		var save_start_time = Date.now();

		$.post(
			'player_service.php?action=save_score&no_cache='+Math.random(),
			{
				media_id: me.app.opts.media_id,
				score: me.score,
				game_type: me.game_type
			},function(data){
				if(data.success) {
					me.gameFinishedView.setSaveStatus(
						'<span class="positive">' + data.message + '</span>'
					);
				} else {
					me.gameFinishedView.setSaveStatus(
						'<span class="negative">' + data.message + '</span>'
					);
				}
				me.loadScoreHistory();
				me.app.refreshGameOptions();

			},'json')
			.fail(function(xhr, status, errorThrown) {
				var save_fail_time = Date.now();
				me.gameFinishedView.setSaveStatus(
					'<span class="negative">' + 'Saving Score Failed!! - Retrying' + status +'</span>'
				);
				var data = JSON.stringify(arguments);
				$.post('player_service.php?action=save_score_fail',{
					error_data: data,
					delay: save_fail_time - save_start_time,
					score: me.score,
					media_id: me.app.opts.media_id,
					game_type: me.game_type,
					version: "fail1"
				},function(data){
					if(data.success) {
					me.gameFinishedView.setSaveStatus(
						'<span class="positive">' + data.message + '</span>'
					);
					} else {
						me.gameFinishedView.setSaveStatus(
							'<span class="negative">' + data.message + '</span>'
						);
					}
					me.loadScoreHistory();
					me.app.refreshGameOptions();
				},'json').fail(function(xhr, status, errorThrown) {
					var save_fail_time = Date.now();
					me.gameFinishedView.setSaveStatus(
						'<span class="negative">' + 'Saving Score Failed!!' + status +'</span>'
					);
					var data = JSON.stringify(arguments);
					$.post('player_service.php?action=save_score_fail',{
						error_data: data,
						delay: save_fail_time - save_start_time,
						score: me.score,
						media_id: me.app.opts.media_id,
						game_type: me.game_type,
						version: "fail2"
					});
					me.loadScoreHistory();
				});
				
			});



	},
	getRound2NextStartingFrom: function(index) {
		var round1Scores = this.response_data[1];
		for(var i=index;i<round1Scores.length;i++) {
			if(round1Scores[i].do_repeat) 
				return i;
		}
		return -1;
	},
	showCurrentState: function() {
		if(this.game_type == 'choice') {
			this.showCurrentStateChoice();
			return;
		}
		this.$q.find('.pre_start').hide();
		this.$q.find('#question_container').hide();
		this.$q.find('#game_over').hide();
		this.$q.find('.next').hide();
		this.$q.find('.choice_buttons').hide();
		this.$q.find('.minikeyboard_container').show();
		this.$submit_answer.hide();
		$('#saving_indicator').hide();
		this.$response.hide();
		
		if(this.state == 'PENDING START') {
			this.$q.find('.pre_start').show();
			this.$q.find('.pre_start .instructions').hide();
			this.$q.find('.pre_start .instructions.cloze').show();
		} 	else if (this.state == 'PENDING ANSWER') {
			this.$q.find('#question_container').show();
			this.$submit_answer.show();
			this.$submit_answer.css('display', 'inline-block');
			this.app.resize();
		} else if (this.state == 'PENDING NEXT') {
			this.$q.find('#question_container').show();
			
			this.$q.find('.next').show();
		}  else if (this.state == 'GAME OVER') {
			this.gameFinishedView.show(this.response_data);
		}
	},
	showCurrentStateChoice: function() {
		this.$q.find('.minikeyboard_container').hide();
		this.$q.find('.pre_start').hide();
		this.$q.find('#question_container').hide();
		this.$q.find('#game_over').hide();
		this.$q.find('.next').hide();
		this.$submit_answer.hide();
		this.$q.find('.choice_buttons').hide();
		$('#saving_indicator').hide();
		this.$response.hide();
		
		if(this.state == 'PENDING START') {
			this.$q.find('.pre_start').show();
			this.$q.find('.pre_start .instructions').hide();
			this.$q.find('.pre_start .instructions.choice').show();
		} 	else if (this.state == 'PENDING ANSWER') {
			this.$q.find('#question_container').show();
			this.$q.find('.choice_buttons').show();
			this.app.resize();
		} else if (this.state == 'PENDING NEXT') {
			this.$q.find('#question_container').show();
			this.$q.find('.choice_buttons').show();
		
		}  else if (this.state == 'GAME OVER') {
			this.gameFinishedView.show(this.response_data);
		}
			

	},
	highlightMissingAccents: function(response,correct,cls) {
		var r = response.split('');
		var c = correct.split('');
		var result = '';
		for(var i=0;i<r.length;i++) {
			if(r[i] == c[i]) {
				result += r[i];
			} else {
				result += '<em class="' + cls + '">'+r[i]+"</em>";
			}
		}
		return result;
	},
	buildQuestions: function(cb) {
		this.questions = [];
		var caption_indexes = this.selectCaptions();
		for(var i=0;i<caption_indexes.length;i++) {
			var question = {};
			var contextObject = this.createCaptionContext(caption_indexes[i]);
			question.caption_index = contextObject.primary_index;
			question.word_index = this.pickWordIndex(question.caption_index);
			question.answer = this.captions[question.caption_index][this.source_words_key][question.word_index].word.replace(/\s/g,'');
			
			question.start_time = contextObject.time_in;
			question.end_time = contextObject.time_out;
			
			// build the text data
			question.text = "";

			if(contextObject.pre_index !== null) {
				question.text = this.wordsToHtml(this.captions[question.caption_index -1][this.source_words_key])
					+ (this.app.opts.media_lang_id.substr(0,2) == 'zh' ? '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;' : '');
			}
			
			// loop over the nwords and build up the actual caption
			var awords = this.captions[question.caption_index][this.source_words_key];
			var space = this.mode == 'hanzi' ? '' : ' ';
			for(var j=0;j<awords.length;j++) {
				if(j==question.word_index) {
					var underline = "";
					for(var x=0;x<awords[j].word.length;x++) {
						underline += '_' ;
					}
					question.text += awords[j].pre + '<span class="underline">' + underline + '</span>' 
							+ awords[j].post + space;
				} else {
					question.text += awords[j].pre + '<a class="game_word" data-lookup="'+ (awords[j].lookup || '') +'">'+awords[j].word +'</a>'+ awords[j].post + space;
				}
			}
			if(contextObject.post_index) {
				question.text += 
					(this.app.opts.media_lang_id.substr(0,2) == 'zh' ? '&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;' : '')
					+ this.wordsToHtml(this.captions[question.caption_index +1][this.source_words_key]);
			}
			this.questions.push(question);
		}

		if(this.game_type == 'cloze') {
			cb();
			return;
		}
		if(this.game_type == 'choice') {
			var me = this;
			var words = this.questions.map(function(v){ return v.answer }).join('||');
			$.get('player_service.php',{ 
					action: 'get_distractors',  
					words:words, 
					word_lang_id:app.opts.media_lang_id, 
					romanization: this.use_romanization ? 1 : ""  
				},
				function(data) {
					me.questions.forEach(function(question,k){
						var choices = data[k].distractors.map(function(v){ return { word:v } });  // convert to obj
						choices.push( { word:data[k].word, is_correct: true } );
						me.shuffle(choices)
						question.choices = choices;
					});
					cb();
				},
				'json'
			);
		}
		
		
	},
	shuffle: function(a) {
		var j, x, i;
		for (i = a.length; i; i--) {
			j = Math.floor(Math.random() * i);
			x = a[i - 1];
			a[i - 1] = a[j];
			a[j] = x;
		}
	},
	wordsToHtml: function(words) {
		var html = "";
		words.forEach(function(w){
			html += w.pre + '<a class="game_word" data-lookup="'+ (w.lookup || '') +'">' + w.word + '</a>'+ w.post + " ";
		});
		return html;

	},
	selectCaptions: function() {
		var failLimit = 40;
		var result  = [];
		var alreadyChosen = {};
		var targetWordLength = 4;
		if(this.app.opts.media_lang_id.substr(0,2) == 'zh') {
			targetWordLength = 1;
		}
		
		while(result.length < this.NUM_QUESTIONS) {
			var index = Math.floor(Math.random() * (this.captions.length ) );
			
			// check if the caption is not just an annotation, or only has crap words.
			var wordArray = this.captions[index][this.source_words_key];
			var num_good_words = 0;
			for(var i=0;i<wordArray.length;i++) {
				var wo = wordArray[i];
				if(wo.word.length >= targetWordLength && !wo.bad_for_game && !wo.is_rare && !this.hasWordBeenUsed(wo.word)) {
					num_good_words++;
				}
			}
			
			if(!alreadyChosen[index] && num_good_words > 1) {
				result.push(index);
				alreadyChosen[index] = true;
			} else if (!alreadyChosen[index] && num_good_words && failLimit < 20) {
				result.push(index);
				alreadyChosen[index] = true;
			} else if (failLimit < 1) {
				result.push(index);
			} else {
				failLimit--;
			}
		}
		result.sort(function(a,b) { return a > b ? 1 : -1});

		return result;
	},
	createCaptionContext: function(caption_index) {
		var co = {};
		// let's construct the "typical object"
		co.primary_index = caption_index;
		co.pre_index = caption_index-1; 
		co.post_index = caption_index+1; 
		// now let's check for problems;
		
		// is the chosen caption the first caption?
		if(co.pre_index < 0) 
			co.pre_index = null;
		// is the chosen caption the last caption?
		if(co.post_index >= this.captions.length) 
			co.post_index = null;
		
		// is there too much space between the pre caption and the chosen caption?
		if(co.pre_index && this.captions[co.pre_index].time_out) {
			if(this.captions[co.primary_index].time_in - this.captions[co.pre_index].time_out > this.MAX_PRECEEDING_WHITESPACE) {
				co.pre_index = null;
			}
		}
		// is there too much space between the post caption, and the chosen caption?
		if(co.post_index && this.captions[co.primary_index].time_out) {
			if(this.captions[co.post_index].time_in - this.captions[co.primary_index].time_out > this.MAX_PRECEEDING_WHITESPACE) {
				co.post_index = null;
			}
		}
		
		// let's determine the frame in and outs
		if(co.pre_index !== null) {
			co.time_in = this.captions[co.pre_index].time_in;
		} else {
			co.time_in = this.captions[co.primary_index].time_in - this.WHITESPACE_PADDING;
			co.time_in = Math.max(co.time_in,0);
		}
		if(co.post_index) {
			co.time_out = this.captions.getTimeOutByIndex(co.post_index);
		} else {
			co.time_out = this.captions.getTimeOutByIndex(co.primary_index);
		}

		return co;
		
	},
	pickWordIndex: function(caption_index) {
		var retries = 100;
		var targetWordLength = 4;
		var wordindex;
		var wordArray = this.captions[caption_index][this.source_words_key];
		if(this.app.opts.media_lang_id.substr(0,2) == 'zh') {
			targetWordLength = 1;
		}

		while(retries > 0) {
			wordindex = Math.floor( Math.random() * wordArray.length );
			var word = wordArray[wordindex].word;
			if(word.length >= targetWordLength 
				&& !this.hasWordBeenUsed(word) 
				&& !wordArray[wordindex].bad_for_game
				&& !wordArray[wordindex].is_rare) {
					this.used_words[word] = true;
					break;
			} else {
				retries--;
				if(retries % 20 == 0) {
					targetWordLength--;
				}
			}
		}
		return wordindex;
	},
	hasWordBeenUsed: function(word) {
		return !!this.used_words[word];
	},
	handleKey: function(key,event) {
		var me = this;
		if(key == 13 && this.state == 'PENDING START') {
			this.$q.find('.start_game:visible').click();
		} 
		if(this.state == 'PENDING NEXT') {
			this.$q.find('.next:visible').click();
		}
		if(key == 32) {
			this.$q.find('.replay.button:visible').click().addClass('pressed');
			setTimeout(function() {
				me.$q.find('.replay.button').removeClass('pressed')
				}, 100);
		}
	}

}, event_mixin);

function Scorer() {
	if(! this instanceof Scorer) 
		return new Scorer();
}
$.extend(Scorer.prototype,{

	missing_letter_caret: '_',
	diff_words: function(source,response) {
		var result = {
			match: false,
			no_accent_match: false,
			source_markup: '',
			response_markup: '',
			hint_markup: '',
			no_partial_match:false
		};
		if(source.toLowerCase().replace(/ß/g,'ss') === response.toLowerCase().replace(/ß/g,'ss')) {
			result.match = true;
			return result;
		}
		var differ = new SuperDiff();

		var d = differ.diff_chars(source,response);
		// only highlight differences if words are similar.
		if(d.cost < Math.max(source.length,response.length) /2) {
			result = $.extend(result,this.format_substitutions(d.substitutions));
		} else {
			result.source_markup = '<span class="swap">' + this.escape(source) + '</span>';
			result.response_markup = '<span class="swap">' + this.escape(response) + '</span>';

			var sl = source.length;
			for(var i = 0;i<sl;i++) {
				if(i == 0 || source.substr(i,1).toLowerCase() == response.substr(i,1).toLowerCase()) {
					result.hint_markup += '<span class="letter match">' + source.substr(i,1) + '</span>';
				} else {
					result.hint_markup += '<span class="letter missing swap">' + this.missing_letter_caret + '</span>';
				}
				
			}
			result.no_partial_match = true;
		}
		
		return result;
	},
	format_substitutions: function(substitutions) {
		var source_html = "",
			response_html = "",
			soft_match = true,
			missing_letter_caret = '_';
		for(var i = 0; i< substitutions.length;i++) {
			var s = substitutions[i];
			var type = s[0];
			if(type === "match") {
				source_html += '<span class="letter match">' + this.escape(s[1]) + '</span>';
				response_html += '<span class="letter match">' + this.escape(s[2]) + '</span>';
			} else if (type === "insert") {
				soft_match = false;
				source_html += '<span class="letter insert">' + this.escape(s[1]) + '</span>';
				response_html += '<span class="letter missing swap">' + this.missing_letter_caret + '</span>';
			} else if (type === "delete") {
				soft_match = false;
				response_html += '<span class="letter delete">' + this.escape(s[2]) + '</span>';
			} else if (type == "soft_swap") {
				source_html += '<span class="letter soft_swap">' + this.escape(s[1]) + '</span>';
				response_html += '<span class="letter soft_swap">' + this.escape(s[2]) + '</span>';
			} else if (type == "swap") {
				soft_match = false;
				source_html += '<span class="letter swap">' + this.escape(s[1]) + '</span>';
				response_html += '<span class="letter swap">' + this.escape(s[2]) + '</span>';
			}
		}
		return { source_markup: source_html, response_markup: response_html, no_accent_match:soft_match, hint_markup: response_html };
	},
	escape: function(s) {
		var n = s;
		n = n.replace(/&/g, "&amp;");
		n = n.replace(/</g, "&lt;");
		n = n.replace(/>/g, "&gt;");
		n = n.replace(/"/g, "&quot;");
		return n;
	}
});

function ClozeGameFinishedView(opts) { this.init(opts); }
$.extend(ClozeGameFinishedView.prototype, {
	init: function(opts) {
		var me = this;
		this.numQuestions = opts.numQuestions;
		this.$e = $('#game_finished_view');
		this.$e.find('.quitgame').on('click touchend',function(e){
			e.preventDefault();
			e.stopPropagation();
			me.hide();
			opts.onQuitGame();
		});
		this.$e.find('.play_again').on('click touchend',function(e) {
			e.preventDefault();
			e.stopPropagation();
			me.hide();
			opts.onPlayAgain();
		})
		this.$e.find('#game_finished_mask').on('click touchend',function(){
			me.$e.find('.quitgame.button').click();
		});

	},
	show: function(response_data) {
		
		var score_html = '';
		var total_points = 0;
		for(var i =0;i<this.numQuestions;i++) {
			var r2 = !!response_data[2][i];
			var points = (response_data[1][i].points + (r2 && response_data[2][i].points || 0));
			total_points += points;
			score_html += '<tr>';
			score_html += '<td class="idx">' + (i+1) + '.</td>';
			score_html += '<td class="source">' + response_data[1][i].source + '</td>';
			score_html += '<td class="'+response_data[1][i].grading+'">' + response_data[1][i].response  + '</td>';
			score_html += '<td class="'+(r2 ? response_data[2][i].grading : '')+'">' 
				+ (r2 ? response_data[2][i].response : '') + '</td>';
			score_html += '<td>' + points + ' pts.</td>';
			score_html += '</tr>';
		}
		this.$e.find('.points').text(total_points)
		this.$e.find('tbody').html(score_html);
		this.$e.css('max-width',$(window).width());
		this.$e.show();
		var $inner = this.$e.find('#game_finished_info')
		$inner.css('left',($('body').width() - $inner.outerWidth())/2 );
	},
	setSaveStatus: function(html) {
		this.$e.find('#save_indicator').html(html);
	},
	hide: function() {
		this.$e.hide();
	}
});


function ListGameTypePicker(vc,app) { this.init(vc,app); }
$.extend(ListGameTypePicker.prototype, {
	init: function(vc,app) {

		this.$e = $('#list_gtp');
		this.app = app;

		var me = this;

		if(app.opts.media_lang_id.substr(0,2) == 'zh') {
			this.$e.find('.game_type').hide().end().find('.game_type.zh_opt').show();
		}
		this.$e.find('a.game_type').on('click touchend',function(e){
			e.preventDefault();
			window.location.replace( $(this).attr('href') );
		})

		$('.choose_game').on('click touchend',function(e){
			e.preventDefault();
			e.stopPropagation();
			vc.pause();
			if (!me.app.opts.youtube_compliance_mode) {
				me.showPicker(this);
			} else {
				me.app.jiggleCaptionCover();
			}
		});

		this.$e.find('div.game_type').on('click touchend',function(e){
			e.preventDefault();
			e.stopPropagation();
			var game_type = $(this).data('game_type');
			var use_romanization = $(this).data('use_romanization');
			me.app.startGame(game_type,use_romanization);
			me.dismiss();
		});

		this.render();
	},
	render: function() {
		var game_opts = this.app.opts.game_opts;
		this.$e[game_opts.no_user ? 'addClass' : 'removeClass']('no_user');

		this.$e.find('.game_type').each(function(){
			var gt = $(this).data('game_type');
			if( $.inArray(gt,game_opts.allowed) === -1 ) {
				$(this).hide()
			}
		});
		this.setCompletionMarkers(game_opts.allowed,game_opts.games);
		this.setAssignmentMarkers(game_opts.allowed,game_opts.games);
		this.addTrophies(game_opts.games);
	},
	setCompletionMarkers: function(available_games,games) {
		if(!games) return;

		var me = this;
		available_games.forEach(function(v) {
			if(games[v] && games[v].completed) {
				me.$e.find('[data-game_type="'+ v +'"]').find('.complete_indicator').addClass('complete');
			}
		});
	},
	addTrophies: function(games) {
		if(!games) return;
		$('#list_gtp .game_type').each(function(){
			var game_type = $(this).data('game_type');
			var trophies = games[game_type] && games[game_type].trophies;
			if(trophies && trophies.has_played) {
				if(trophies.trophies && trophies.trophies.length) {
					$(this).find('.trophies').html(trophies.html);
				} else {
					$(this).find('.trophies').html(
						$('<span class="has_played"><i class="fa fa-certificate"></i></span>')
							.attr('title','Play again to earn trophies.')
					);
				}

			}

		});
	},
	setAssignmentMarkers: function(available_games,games) {
		if(!games) return;
		var me = this;
		var has_assignment = false;
		available_games.forEach(function(v) {
			if(games[v] && games[v].assigned) {
				var $row = me.$e.find('[data-game_type="'+ v +'"]').addClass('assigned');
				$row.find('assign_indicator').removeClass('assigned completed progress');
				if(games[v].assignments.length > 1) {
					$row.find('.assign_indicator').addClass('assigned')
				} else {
					if(games[v].assignments[0].is_complete) {
						$row.find('.assign_indicator').addClass('completed');
					} else if (games[v].assignments[0].score > 0) {
						$row.find('.assign_indicator').addClass('progress')
							.find('.progress').html(games[v].assignments[0].progress_html)
					} else {
						$row.find('.assign_indicator').addClass('assigned')
					}
				}
				has_assignment = true;
			} else {
				me.$e.find('[data-game_type="'+ v +'"]').addClass('not_assigned');
			}
		});
		if(!has_assignment) {
			me.$e.find('.game_type').removeClass('not_assigned');
		}
	},
	showPicker: function(elem) {
		var $el = $(elem);
		var eo = $el.offset();
		var ew = $el.outerWidth();
		var me = this;

		this.$e.show();
		this.$e.css({
			left: eo.left - this.$e.outerWidth() + ew,
			top: eo.top - this.$e.outerHeight() -2
		});
		$(document).on('click.lgtp touchend.lgtp',function(){
			me.dismiss();
		});
		$(document).on('keyup.lgtp',function(e){
			if(e.which == 27) {
				me.dismiss();
			}
		});

	},
	dismiss: function() {
		this.$e.hide();
		$(document).off('click.lgtp touchend.lgtp');
		$(document).off('keyup.lgtp');
	},

});

var LaunchOptionsController = {
	init: function(lopts,app,vc,video_end_controller,caption_display) {
		if(lopts.fullscreen) {
			app.enterFullscreen();
		}
		if(lopts.play_through) {
			video_end_controller.auto_jump_to_next = true;
		}
		if(lopts.hide_text) {
			caption_display.hideByCode(lopts.hide_text);
		}
		vc.bind('loadingfinished',function() {
			lopts.slow && vc.slow();
		});
		vc.bind('durationavailable',function(){
			// for some reason it doesn't work without a delay.
			setTimeout(function(){
				lopts.time && vc.seekTo(lopts.time,true);
			},100);

			lopts.game_type && setTimeout(function(){
				vc.pause();
				app.startGame(lopts.game_type,lopts.use_romanization);
			}, 100);
			
		})
	}

}
var PlayedThroughTracker = {
	init: function(video_log_id, vc, app) {
		if(!video_log_id) {
			return;
		}

		this.vc = vc;
		this.curEngagementStart = false;
		this.engagementTime = 0;

		var me = this;
		var start_time = new Date();
		var video_duration = null;
		var played_through = 0;
		var played_through_pct = 0;
		var last_played_through_pct = 0;
		var played_through_threshold = 5;

		var last_sent_engagement_time = 0;
		var engagement_threshold = 10;

		var done = false;
		var hasPlayed = false;
		vc.bind('durationavailable',function(e,d){
			video_duration = d.duration - 0.1;
			if(last_played_through_pct == 0) {
				$.post('player_service.php?action=update_played_through',
					{
						played_through_pct: 1,
						video_log_id: video_log_id
					},function(){
						// fire and forget
					},'json');
			}
			
		}).bind('seekstarted', function(e, d) {
			me.endEngagement(d.from);
			me.beginEngagement(d.to);
		}).bind('play', function() {
			me.beginEngagement(vc.currentTime());
		}).bind('playstatechange', function() {
			if (vc.isPaused()) {
				me.endEngagement(vc.currentTime());
			} else if (!hasPlayed) {
				hasPlayed = true;
				me.beginEngagement(vc.currentTime());
			}
		});
		var timer = setInterval(function(){
			if(video_duration && !done) {
				var temp_played_through = vc.currentTime();
				var open_ms = (new Date()).getTime() - start_time.getTime();
				played_through = Math.min(open_ms/1000, temp_played_through);
				played_through_pct = played_through / video_duration * 100;
				var engagement_time = me.engagementTime + ((me.curEngagementStart === false) ? 0 : (temp_played_through - me.curEngagementStart));

				var played_through_change = played_through_pct - last_played_through_pct;
				var engagement_time_change = engagement_time - last_sent_engagement_time;
				if (played_through_change > played_through_threshold || engagement_time_change >= engagement_threshold) {
					if (played_through_change > 0) {
						last_played_through_pct = played_through_pct;
					}
					last_sent_engagement_time = engagement_time;
					
					$.post('player_service.php?action=update_played_through',
						{
							played_through_pct: last_played_through_pct,
							engagement_time: last_sent_engagement_time,
							video_log_id: video_log_id
						},function(){
							// fire and forget
						},'json')
				}
			}
		},1000);
	},

	beginEngagement: function(inTime) {
		if (this.curEngagementStart !== false)
			this.endEngagement(this.vc.currentTime());

		this.curEngagementStart = inTime;
	},
	endEngagement: function(outTime) {
		if (this.curEngagementStart === false)
			return;

		this.engagementTime += (outTime - this.curEngagementStart)
		this.curEngagementStart = false;
	},
}

function Application(opts) { this.init(opts); }
$.extend(Application.prototype, {
	init:function(opts) {
		this.media_id = MEDIA_ID;
		this.opts = $.extend({
			media_id: null,
			media_lang_id: 'xx',
			media_lang_name: 'XXX',
			translation_lang_id: null,
			translation_lang_name: null, 
			disable_translations: true,
		},opts);
		this.device = {
			is_ipad: navigator.userAgent.indexOf('iPad') != -1,
			is_iphone: navigator.userAgent.indexOf('iPhone') != -1 && navigator.userAgent.indexOf('iPad') == -1,
			is_android: /android/i.test(navigator.userAgent),
			is_touch: ('ontouchstart' in window),
			is_safari: navigator.userAgent.indexOf('Safari') != -1,
			is_phone: /(phone|mobile|ipod)/i.test(navigator.userAgent) && navigator.userAgent.indexOf('iPad') == -1
			
		};
		if(this.device.is_iphone) {
			$('body').addClass('iphone');
		}
		var ch = navigator.userAgent.match(/Chrome\/(\d+)/);
		if(ch && parseInt(ch[1]) >= 50) {
			this.device.is_modern_chrome = true;
		}

		// android 4.4+
		var an = navigator.userAgent.match(/Android (\d+)\.(\d+)/);
		if(an && parseInt(an[1]) >=5 ) {
			this.device.is_modern_android = true;
		} if(an && parseInt(an[1]) == 4 && parseInt(an[2]) == 4) {
			// this.device.is_modern_android = navigator.userAgent.match(/M919/);
		}

		if(this.device.is_ipad) {
			this.device.ios_version = (navigator.appVersion).match(/OS (\d+)_(\d+)_?(\d+)?/) || [0,9,0,0];
		}
		this.device.overseek_allowance = this.device.is_ipad || this.device.is_safari ? .7 : 0,
		
		this.$e = $('body');
		this.currentGameType = null;

		
		// iPhone works better with touch enabled
		if(this.device.is_touch && !this.device.is_iphone) {
			this.disableTouchScrolling();
		}
		

		this.device.is_ipad && $('body').removeClass('not_ipad').addClass('ipad');

		if(this.device.is_ipad) {
			// iPad specific bug fix.
			$('input').on('blur',function(){ $(window).scrollTop(0); });
		}
		
		if(this.device.is_ipad && this.device.ios_version[1] >= 8) {
			$('.noslow').hide();
			$('.slow.button').css('display','inline-block');
		} else if (this.device.is_android) {
			if(!this.device.is_modern_chrome || !this.device.is_modern_android){
				$('.slow.button').hide();
				$('.noslow_android').css('display','inline-block');
			}
		}
		
		var captions = $.extend(CAPTIONS,caption_methods);
		var poster_url = '//d2mllj54g854r4.cloudfront.net/media/'+ MEDIA_ID +'/cover.jpg';
		if(this.device.is_touch) {
			$('body').addClass('touch_device');
		}
		if(navigator.userAgent.indexOf('MSIE') !== -1) {
			$('body').addClass('msie');
		}
		
		if(this.opts.media_lang_id.substr(0,2) == 'zh') {
			$('body').addClass('chinese');
		}


		function constructorForSource(source) {
			switch (source) {
				case 'youtube': return YouTubeVideoController;
				default: return VideoController;
			}
		}
		var constructor = constructorForSource(VIDEO_HOST);
		var vc = this.vc = new constructor(VIDEO_URL,captions,poster_url, this.device.overseek_allowance, VIDEO_RANGE);

		var loadingEventLookup = {
			canplay: false,
			canplaythrough: false,
			firstplay: false,
		};
		vc.bind('canplay canplaythrough durationavailable firstplay', function(e) {
			if (loadingEventLookup[e.type])
				return true;
			else
				loadingEventLookup[e.type] = true;

			var timestamp = Date.now();
			// We shouldn't be sending 4 requests back to back within 30 ms of each other right as the video is starting to play, 
			// then saving them in the database with a 1 second resolution.

			// $.post('/player_service.php', {
			// 	action: 'log_video_loading_event',
			// 	video_log_id: me.opts.vlid,
			// 	event: e.type,
			// 	timestamp: timestamp,
			// });
		});

		var infoPanel = new InfoPanel(this.opts,this.device);
		var modalDict = new ModalDictionary();

		this.listGamePicker = new ListGameTypePicker(vc,this);

		// we don't actually need references to these
		var captionDisplay = new CaptionDisplay(vc,captions,infoPanel,modalDict, this);
		new ScrubBar(vc,captions);
		new LoadingSpinner(vc);
		
		var video_end_display = new VideoEndDisplay(vc,captionDisplay,this);

		this.playbackControls = new PlaybackControls(vc,captions,infoPanel,this);
		this.cloze_game_controller = new GameController(vc,captions, this, modalDict);
		this.dictation_controller = new Scribe.Controller(vc, captions,modalDict, this, this.opts.media_lang_id);
		this.commentController = new CommentController(this.media_id);
		this.commentPane = new CommentPane($('#comment_pane'), this.commentController);
		LaunchOptionsController.init(this.opts.launch_options || {},this,vc,video_end_display,captionDisplay);
		PlayedThroughTracker.init(this.opts.vlid, vc,this);

		var me = this;

		this.window_is_active_tab = true;
		$(window).focus(function() { me.window_is_active_tab = true; });
		$(window).blur(function() { me.window_is_active_tab = false; });

		var video_click_controller = new VideoClickController(vc,function(){
			return me.getActiveController();
		});

		// setup keyboard shortcuts
		$('body').on('keydown.html5_player', function(e) {
			if( !$(e.target).is('input') ) {  // not in an input field
				var active_controller = me.getActiveController();
				active_controller && active_controller.handleKey(e.which,e);
			}
		});

		// exit button 
		$('#main_exit i').on('click',function(){
			console.log("blah",window.history.length);
			if(window.history.length > 1) {
				window.history.back();
			} else {
				if(me.opts['is_paying_user']) {
					window.location.replace("./videos.php");
				} else {
					window.location.replace( './' );
				}
			}
		});
		
		this.disableTextSelection();
		this.disableBackspaceNavigation();
		this.device.is_touch && this.showTouchToStartMessage(vc);

		$(window).resize($.proxy(this.resize,this)).resize();

		this.vc.bind('loadingfinished',function(){
			me.resize();
			// (VIDEO_HOST === "youtube") && me.showClickToStartMessage(vc);
		});
		this.$e.find('.quit_game.button, header.game_controls .quit').on('click touchend',function(e){
			e.preventDefault();
			me.exitGame();
		});
		this.$e.bind('orientationchange',function(e){
			me.resize();
		});

		if ($('body').hasClass('promo')) {
			setTimeout(function() {
				$('#promo_banner').addClass('show');
			}, 12000);
		}

		if(opts.youtube_compliance_mode) {
			$('body').addClass('youtube_compliance_mode');
		}
	},
	getActiveController: function() {
		var active_controller;
		if(this.currentGameType == 'cloze' || this.currentGameType == 'choice') {
			active_controller = this.cloze_game_controller;
		} else if (this.currentGameType == 'dictation') {
			active_controller = this.dictation_controller;
		} else {
			active_controller = this.playbackControls;
		}
		return active_controller;
	},
	enterFullscreen: function() {
		if(this.device.is_android) {
			this._requestFullScreenFromBrowser();
		}
		TrackEvent('enterFullscreen');
		this.$e.addClass('fullscreen');
		this.is_fullscreen = true;
		if (!this.opts.youtube_compliance_mode) {
			$('#captions').appendTo('#video_container');
		}
		this.resize();
		this.trigger('fullscreenchange');
	},
	exitFullscreen: function() {
		TrackEvent('exitFullscreen');
		this._cancelFullScreenFromBrowser();
		$('body').removeClass('fullscreen');
		if(this.device.is_ipad == 'iPad')
			$('#video_container').css('padding-bottom','');
		if (!this.opts.youtube_compliance_mode) {
			$('#video_wrap').after($('#captions'));
		}
		this.is_fullscreen = false;
		this.resize();
		this.trigger('fullscreenchange');
	},
	refreshGameOptions: function(callback) {
		var me = this;
		$.get('player_service.php',
			{ action: 'get_game_options', media_id: this.media_id },
			function(res) {
				me.opts.game_opts = res;
				me.listGamePicker.render();
			},
			'json'
		);
	},
	startGame: function(gameType,use_romanization) {
		this.is_fullscreen && this.exitFullscreen();
		if( $.inArray(gameType,this.opts.game_opts.allowed) === -1 ) {
			return this.startGame(this.opts.game_opts.allowed[0],!!use_romanization);
		}
		
		if (gameType) {
			this.currentGameType = gameType;
			if (gameType == 'cloze') {
				this.$e.addClass('game');
				this.cloze_game_controller.start(gameType,!!use_romanization);
				this.resize();
			} else if (gameType == 'choice'){

				this.$e.addClass('game');
				this.cloze_game_controller.start(gameType,!!use_romanization);
				this.resize();
			} else if (gameType == 'dictation') {
				this.$e.addClass('d_game');
				this.dictation_controller.start(!!use_romanization);
			}
		}
	},
	exitGame: function() {
		if (this.currentGameType == 'cloze' || this.currentGameType == 'choice') {
			this.cloze_game_controller.exit();
		}
		else if (this.currentGameType == 'dictation') {
			this.dictation_controller.exit();
		}

		this.$e.removeClass('game d_game');
		this.$e.removeClass(this.currentGameType);
		this.currentGameType = null;

		this.resize();
	},
	jiggleCaptionCover: function() {
		$('#caption_cover').addClass('jiggle');
		setTimeout(function() {
			$('#caption_cover').removeClass('jiggle');
		}, 500);
	},
	showTouchToStartMessage: function(vc) {
		var $vc = $(vc);
		var $msg = $('#tap_to_start_tip').show();
		// we need an event that fires when load has started;
		// android fires timeupdate,canplay before the video has loaded.
		var progress_event_count = 0;
		$vc.on('play.XYZ playing.XYZ progress.XYZ playstatechange.XYZ',function(e) {
			if(e.type == 'progress' && progress_event_count == 0) {
				progress_event_count++;
				return;
			}
			$msg.remove();
			$vc.off('play.XYZ playing.XYZ progress.XYZ playstatechange.XYZ');
		});
	},
	showClickToStartMessage: function(vc) {
		var $vc = $(vc);
		var $msg = $('#click_to_start_tip').show();
		// we need an event that fires when load has started;
		// android fires timeupdate,canplay before the video has loaded.
		var progress_event_count = 0;
		$vc.on('play.XYZ playing.XYZ progress.XYZ playstatechange.XYZ',function(e) {
			if(e.type == 'progress' && progress_event_count == 0) {
				progress_event_count++;
				return;
			}
			$msg.remove();
			$vc.off('play.XYZ playing.XYZ progress.XYZ playstatechange.XYZ');
		});
	},
	disableTextSelection: function() {
		$('body').bind('selectstart',function(e) {
			if($(e.target).is('input') || $(e.target).closest('.info_text').length )
				return true;
			return false;
		});
	},
	disableBackspaceNavigation: function() {
		$(document).on('keydown',function(e){
			if (e.which === 8 && !$(e.target).is("input:not([readonly]), textarea")) {
        		e.preventDefault();
    		}
		});
	},
	disableTouchScrolling: function() {
		var selScrollable = '.scrollable';
		// Uses document because document will be topmost level in bubbling
		$(document).on('touchmove',function(e){
		  e.preventDefault();
		});
		// Uses body because jQuery on events are called off of the element they are
		// added to, so bubbling would not work if we used document instead.
		$('body').on('touchstart', selScrollable, function(e) {
			var ct = e.currentTarget;
			if (ct.scrollTop === 0) {
				ct.scrollTop = 1;
			} else if (ct.scrollHeight === $(ct).height() + ct.scrollTop) {
				ct.scrollTop -= 1;
			}
		});
		// Stops preventDefault from being called on document if it sees a scrollable div
		$('body').on('touchmove', selScrollable, function(e) {
			if($(this)[0].scrollHeight > $(this).innerHeight()) {
				e.stopPropagation();
			}
		});
	},
	resize: function() {
		$(document).scrollTop(0);
		if( this._shouldBePortrait() && this.is_fullscreen ) {
			this.exitFullscreen();
		}

		$('body').removeClass('portrait portrait_phone');
		if(!this.is_fullscreen) {
			$('body').removeClass('landscape_phone');
		}

		if( this.is_fullscreen ) {
			this._resizeFullscreen();
		} else if (this.currentGameType == 'cloze' || this.currentGameType == 'choice') {
			this._resizeGameMode();
		} else if (this.currentGameType == 'dictation') {
			this._resizeDictationMode();
		} else if (this._shouldBeLandscapeWide() && !this.is_fullscreen) {
			$('body').addClass('landscape_phone');
			this.enterFullscreen();
			return;
		} else {
			this._resizeNormal();
		}
		
		this.vc.resizeVideo();

		if (this.currentGameType == 'cloze' || this.currentGameType == 'choice') {

		} else if (this.currentGameType == 'dictation') {
			this.dictation_controller.resize();
		}
	},
	_resizeFullscreen: function() {
		var wh = this._getWindowHeight();
		var target_height = wh - $('#playback_controls').outerHeight() - $('#controls').outerHeight();
		$('#left_col, #right_col').css('width','');
		$('#video_container').css('height', Math.max(target_height,100) );

	},
	_resizeGameMode: function() {
		var wh = this._getWindowHeight();
		this._layoutPortraitCols(true);
		var target_height = 
			wh - $('#left_col').height() + $('#video_container').height() - $('#video_container').offset().top;
		$('#video_container').css('height', $.clamp(target_height,100,this._maxVideoContainerHeight() ) );
		
		this._positionVideoAlignedPanel();

		// $('#game_panel').css('height',Math.max(
		// 	wh - $('#game_panel').offset().top -17,
		// 	220));
	},
	_resizeDictationMode: function() {
		var wh = this._getWindowHeight();
		this._layoutPortraitCols(true);
		var target_height = 
			wh - $('#left_col').height() + $('#video_container').height() - $('#video_container').offset().top;
		var maxVidHeight = Math.min(this.dictation_controller.maxVideoContainerHeight(), this._maxVideoContainerHeight());
		var newHeight = $.clamp(target_height,100,maxVidHeight);
		$('#video_container').css('height', newHeight );
	},
	_positionVideoAlignedPanel: function(){
		if( this._isLandscape() ) { 
			var vcb = $('#video_container').offset().top + $('#video_container').outerHeight();
			var itp = $('#info_panel').offset().top;
			$('#info_panel .align_to_video_bottom').css({ top: vcb - itp });
		} else {
			$('#info_panel .align_to_video_bottom').css({ top: 0 });
		}

	},
	_resizeNormal: function() {
		var wh = this._getWindowHeight();
		this._resizeCols();
		var target_height
		// resize the video container

		if(this._isLandscape()) {
			target_height = 
				wh - $('#left_col').height() + $('#video_container').height() - $('#video_container').offset().top;
				target_height = $.clamp(target_height,100,this._maxVideoContainerHeight());
				target_height = this._nearestDivisibleBy(target_height,2);
			$('#video_container').css('height', target_height); 
		} else {

			target_height = $('#left_col').width() / (this.vc.videoAspectRatio() || 16/9);
			$('#video_container').css('height', target_height); 
		}

		var $elem = $('#dictionary .info_text');
			$elem.css('height',Math.max( wh - $elem.offset().top -10,100));

	},
	_shouldBePortrait: function() {
		var w = $('body').outerWidth();
		var h = $(window).innerHeight();
		if(h > w * 1.4) 
			return 2;
		return h > w * 1.2 ? 1 : false;
	},
	_resizeCols: function() {
		var x;
		if( x = this._shouldBePortrait() ) {
			this._layoutPortraitCols(x);
		} else {
			this._layoutLandscapeCols();
		}
	},
	_shouldBeLandscapeWide:function() {
		var w = $('body').outerWidth();
		var h = $(window).innerHeight();
		if(this.device.is_phone && w > h *1.4)  {
			return true;
		}
		return false

	},
	_layoutLandscapeCols: function() {
		var iw = $('body').width();
		var lc_width = this._nearestDivisibleBy( iw * .65 , 8);
		var rc_width = Math.round(iw * .34);

		$('#left_col').css('width',lc_width);
		$('#right_col').css('width',rc_width);
	},
	_layoutPortraitCols:function(n) {
		$('#left_col').css('width','');
		$('#right_col').css('width','');

		$('body').addClass('portrait');
		if(n == 2)
			$('body').addClass('portrait_phone');

	},
	_isLandscape: function() {
		return !$('body').hasClass('portrait');
	},
	_maxVideoContainerHeight: function() {
		var aspectRatio = this.vc.videoAspectRatio();
		var max_container_height;
		if(aspectRatio) {
			max_container_height = Math.ceil($('#video_container').width() / aspectRatio)+1;
		} else {
			max_container_height = Math.round($('#video_container').width() * 3 / 4 );
		}
		return max_container_height;

	},
	_requestFullScreenFromBrowser: function() {
		var doc = window.document;
		var docEl = doc.documentElement;
		var requestFullScreen = docEl.requestFullscreen || docEl.mozRequestFullScreen || docEl.webkitRequestFullScreen || docEl.msRequestFullscreen;
		requestFullScreen && requestFullScreen.call(docEl);
	},
	_cancelFullScreenFromBrowser: function(){
		var doc = window.document;
		var docEl = doc.documentElement;
		var cancelFullScreen = doc.exitFullscreen || doc.mozCancelFullScreen || doc.webkitExitFullscreen || doc.msExitFullscreen;
		cancelFullScreen && cancelFullScreen.call(doc);

	},
	_getWindowHeight: function() {
		var wh = $(window).height();
		if(this.device.is_ipad && window.innerHeight) { // ios7 bug.
			wh = window.innerHeight;
		} 
		return wh;
	},
	_nearestDivisibleBy:function(n,d) {
		var r = n % d;
		var d2 = d/2;
		var v = r > d2 ? n + (d - r) : n - r;
		v = Math.round(v);
		return v;
	}
}, event_mixin);

function initTitleSelector() {
	$('#title_selector').on('click touchstart',function(e) {
		e.stopPropagation();
		if($('#media_options').is(':hidden')) {		
			$('#media_options').css({
				width: $(this).outerWidth(),
				top: $(this).outerHeight() +1
			}).show().css('max-height',  $(window).innerHeight() - $('#media_options').offset().top);
			$('body').on('click.ts_dismiss',function() {
				$('#media_options').hide();
				$('body').off('click.ts_dismiss');
			});
		} else {
			$('#media_options').hide();
		}
		return false;
	});
	$('#media_options li').bind('click',function(e) {
		$('#media_selector').trigger('change',{ value: $(this).attr('data-value') });
		$(this).closest('ul').hide();
	});

	var current_media_id = MEDIA_ID;
	$('#media_selector').change(function(e,d) {
		var target_media_id = parseInt(d.value);
		if( target_media_id != current_media_id ) {
			window.location.replace(queryStringApply( 
				window.location.href,
				{id:target_media_id},
				{
					time: null,
					fullscreen: null,
					slow: null,
				}));
		}
	});
}


return {

	// Video Controllers & View Elements
	VideoController: VideoController,
	ScrubBar: ScrubBar,
	PlaybackControls: PlaybackControls,
	VideoClickController: VideoClickController,
	VideoEndDisplay: VideoEndDisplay,

	// Other non-game interface elements
	CaptionDisplay: CaptionDisplay,
	InfoPanel: InfoPanel,
	ModalDictionary: ModalDictionary,
	MiniKeyboard: MiniKeyboard,

	// Vocab Game Controller & View Elements
	GameController: GameController,
	Scorer: Scorer,
	ClozeGameFinishedView: ClozeGameFinishedView,

	// Application Code
	ListGameTypePicker: ListGameTypePicker,
	Application: Application,

	initTitleSelector: initTitleSelector,
};

})(jQuery);





/********************************/
/* /js/scribe.js */
/********************************/

"use strict";

var Scribe = (function($) {

	// template localizer
	function localize(key) { return $('#localized_strings').find('.'+key).text(); }

	// sfx
	function playSoundId(soundId, volume) {
		var snd;
		if(soundId == 'correct_sound') {
			snd = new Audio('//d2mllj54g854r4.cloudfront.net/images/vocab/correct1.mp3');
			snd.volume = volume;
			snd.play();
		}
	}

	// polyfill / fixes
	// http://paulirish.com/2011/requestanimationframe-for-smart-animating/
	// http://my.opera.com/emoller/blog/2011/12/20/requestanimationframe-for-smart-er-animating
	// requestAnimationFrame polyfill by Erik Möller. fixes from Paul Irish and Tino Zijdel
	// MIT license
	(function() {
		var lastTime = 0;
		var vendors = ['ms', 'moz', 'webkit', 'o'];
		for(var x = 0; x < vendors.length && !window.requestAnimationFrame; ++x) {
			window.requestAnimationFrame = window[vendors[x]+'RequestAnimationFrame'];
			window.cancelAnimationFrame = window[vendors[x]+'CancelAnimationFrame']
				|| window[vendors[x]+'CancelRequestAnimationFrame'];
		}

		if (!window.requestAnimationFrame) {
			window.requestAnimationFrame = function(callback, element) {
				var currTime = new Date().getTime();
				var timeToCall = Math.max(0, 16 - (currTime - lastTime));
				var id = window.setTimeout(function() { callback(currTime + timeToCall); }, timeToCall);
				lastTime = currTime + timeToCall;
				return id;
			};
		}

		if (!window.cancelAnimationFrame) {
			window.cancelAnimationFrame = function(id) { clearTimeout(id); };
		}
	}());

	$.fn.touchClickBind = function(handler) {
		var startX, startY, tap;
		function getCoord(e, c) { return /touch/.test(e.type) ? (e.originalEvent || e).changedTouches[0]['page' + c] : e['page' + c]; }
		function setTap() {
			tap = true;
			setTimeout(function () { tap = false; }, 500);
		}

		$(this).on('touchstart', function (ev) {
			startX = getCoord(ev, 'X');
			startY = getCoord(ev, 'Y');
		}).on('touchend', function (ev) {
			// If movement is less than 20px, execute the handler
			if (Math.abs(getCoord(ev, 'X') - startX) < 20 && Math.abs(getCoord(ev, 'Y') - startY) < 20) {
				// Prevent emulated mouse events
				ev.preventDefault();
				handler.call(this, ev);
			}
			setTap();
		}).on('click', function (ev) {
			if (!tap) {
				// If handler was not called on touchend, call it on click;
				handler.call(this, ev);
			}
			ev.preventDefault();
		});

		return this;
	}

	// mixins
	var state_machine_mixin = {
		// state_machine_mixin uses two callbacks:
		//      stateWillChange(toState, fromState, arg)
		//      stateDidChange(toState, fromState, arg)
		// These are optional.
		_state: 'UNINITIALIZED',
		gotoState: function(state, arg) {
			var fromState = this._state;
			this.prevState = fromState;
			this.stateWillChange && this.stateWillChange(state, fromState, arg);
			this._state = state;
			this.stateDidChange && this.stateDidChange(state, fromState, arg);
		},
		isInState: function(state) { return this._state === state; },
	};
	var show_hide_mixin = {
		performShowAnimation: function(animationClass, onAnimate) {
			document.activeElement.blur();
			animationClass = animationClass || '';
			var $e = this.$e;
			$e.addClass('show '+animationClass);
			if (!!$e) {
				setTimeout(function() {
					$e.addClass('transition');
					setTimeout(function() {
						$e.addClass('revealed');
						onAnimate && onAnimate();
						setTimeout(function() {
							$e.removeClass('transition');
						}, 400);
					}, 200);
				});
			}
		},
		performHideAnimation: function(animationClass, onAnimate) {
			document.activeElement.blur();
			animationClass = animationClass || '';
			var $e = this.$e;
			if (!!$e) {
				setTimeout(function() {
					$e.addClass('transition');
					setTimeout(function() {
						$e.removeClass('revealed');
						onAnimate && onAnimate();
						setTimeout(function() {
							$e.removeClass('transition show '+animationClass);
						}, 400);
					}, 200);
				});
			}
		}
	};
	var popup_mixin = {
		initPopup: function($e, onEnter) {
			this.$e = $e;
			this.onEnter = onEnter || function() { console.log("**** UNIMPLEMENTED onEnter IN initPopup ****"); };
		},
		showPopup: function() {
			this.performShowAnimation && this.performShowAnimation();
			var $popup = this.$e.find('.dict_popup');
			$popup.css('margin-top', -$popup.outerHeight()/2);
		},
		hidePopup: function() { this.performHideAnimation && this.performHideAnimation(); },
	};
	var default_callback_mixin = {
		defaultCallback: function(callbacks, key) {
			function unimp(name) { return function() { Logger.log("**** UNIMPLEMENTED CALLBACK "+name+" ****"); }; }
			return (callbacks[key] && callbacks[key].bind(this)) || unimp(key);
		},
	};
	var dictation_report_mixin = {
		initReport: function($e, onEnter) {
			this.$e = $e;
			this.onEnter = (onEnter && onEnter.bind(this)) || function() { Logger.log("UNIMPLEMENTED onEnter"); };
		},
		showReport: function(asModal) {
			this.isModal = !!asModal;
			this.$e.find('.dismiss.dict_button')[asModal ? 'show' : 'hide']();
			this.performShowAnimation && this.performShowAnimation(asModal ? 'modal' : false);
			this.resize && this.resize();
		},
		hideReport: function() {
			var me = this;
			this.performHideAnimation && this.performHideAnimation(this.isModal ? 'modal' : false, function() {
				me.onHide && me.onHide();
			});
		},
		buildScroller: function(elt) {
			!!this.scroller && !!this.scroller.scroller.parentNode && this.scroller.destroy();
			this.scroller = new IScroll(elt, {
				mouseWheel: true,
				scrollbars: 'custom',
				interactiveScrollbars: true,
			});
		},
	};
	var panel_mixin = {
		panelIsShown: false,
		initPanel: function(panelClass, callback) {
			this.$cont = $('#panels_container');
			this.$bd = $('#panels_backdrop');
			this.$e = this.$cont.find('.game_panel.'+panelClass);
			this.$tab = this.$cont.find('.tab.'+panelClass);

			this.$tab.on('click touchend', this.showPanel.bind(this));
			this.$e.find('.close.dict_button').on('click touchend', this.hidePanel.bind(this));
			this.callback = !!callback ? callback.bind(this) : function() { console.log("*** UNIMPLIMENTED PANEL CALLBACK ***"); };

			this.onEnter = this.onEnter || this.hidePanel;
		},
		showPanel: function() {
			var me = this;
			$('body').addClass('panel_shown');
			this.performShowAnimation && this.performShowAnimation('', function() {
				me.$e.css('left', -me.$e.outerWidth());
				me.onShow && me.onShow();
				me.callback(true);
				me.$bd.addClass('show');
			});
		},
		hidePanel: function() {
			var me = this;
			me.$bd.removeClass('show');
			this.performHideAnimation && this.performHideAnimation('', function() {
				me.$e.css('left', '');
				me.onHide && me.onHide();
				me.callback(false);
				$('body').removeClass('panel_shown');
			});
		},
		resize: function() {
			var $e = this.$e;
			if ($e.hasClass('show'))
				$e.css('left', -$e.outerWidth());
			else
				$e.css('left', '');
		}
	};


	// correctionFlipper jQuery plugin
	(function($) {
		var flipDelay = 1400;
		function flipFunc($flipper) {
			return function() {
				$flipper.find('.flipper_container').toggleClass('flipped');
			};
		}
		function stopFlipping($flipper) {
			if ($flipper.data('flipTimer')) {
				clearInterval($flipper.data('flipTimer'));
			}
		}
		function startFlipping($flipper) {
			stopFlipping($flipper);
			flipFunc($flipper)();
			$flipper.data('flipTimer', setInterval(flipFunc($flipper), flipDelay));
		}
		$.fn.correctionFlipper = function(opts) {
			return this.each(function() {
				var $t = $(this);
				if (typeof opts === 'string') {
					if (opts === 'stop') {
						stopFlipping($t);
					}
				} else {
					$t.empty();
					var $front = $('<div class="front" />').text(opts.incorrect);
					var $back = $('<div class="back" />').text(opts.correct);
					var $flipper = $('<div class="flipper" />').append($front).append($back).wrap('<div class="flipper_container" />');
					var $container = $('<div class="flipper_container" />').append($flipper);
					$t.append($container);
					var flipperSize = {
						width: $front.outerWidth(),
						height: $front.outerHeight()
					}
					$flipper.width(flipperSize.width);
					$flipper.height(flipperSize.height);
					startFlipping($t);
				}
			});
		}
	}(jQuery));

	$.fn.flipTo = function(text,opts) {
		var o = $.extend({
			animationDuration: 1000,
			onSwap: $.noop,
			onComplete: $.noop
		},opts);
		return this.each(function(){
			var $t = $(this);
			if(!opts.animationDuration) {
				$t.text(text);
				o.onComplete();
				return;
			}
			$t.addClass('flipper').css('transition','all ' + parseInt(o.animationDuration/2) +'ms linear').addClass('flip_squeeze');
			setTimeout(function(){
				$t.text(text).removeClass('flip_squeeze').addClass('flip_changed');
				o.onSwap()
			},o.animationDuration/2);
			setTimeout(function(){
				$t.addClass('flip_ended');
				o.onComplete();
			},o.animationDuration);
		});
	};

	// scoreLabel jQuery plugin
	(function($) {
		function setScoreLabelScore($label, score, animationDuration) {
			if ($label.data('runningTimer')) {
				clearTimeout($label.data('runningTimer'));
			}
			if (animationDuration) {

				var start_time = Date.now();
				var end_time = start_time + animationDuration;
				var start_score = parseInt($label.text()) || 0;
				var diff = Math.abs(score - start_score);

				(function step() {
					$label.data('runningTimer', setTimeout(function() {
						var current_time = Date.now();
						if(current_time < end_time) {
							var target_score = (score - start_score) * (current_time - start_time)/animationDuration + start_score;
							$label.text( parseInt(target_score) || 0 );
							step();
						} else {
							$label.text(score);
						}

					}, Math.max(15, animationDuration / diff) )); // no more than 60 updates per second
				})()
			} else {
				$label.text(score);
			}
		}
		$.fn.stepToValue = function(value, duration) {
			return this.each(function() {
				setScoreLabelScore($(this),value,duration)+extraClasses;
			});
		}
	}(jQuery));

	var DictationFeedbackWrapper = {
		wrapWord: function(word) {
			return $('<span>').addClass('word_container'+DictationDiff.wordDataClass(word))
				.append($('<span class="word">')
					.prepend($('<span class="pre">').text(word.pre))
					.append($('<span class="content">').text(word.word)))
					.append($('<span class="post">').text(word.post));
		},
		wordWithHinting: function(wordObj, hintedFlags, accentHintedFlags) {
			var $cont = this.wrapWord(wordObj);
			var $word = $cont.find('.word .content').empty();
			hintedFlags.forEach(function(h, i) {
				var rawText = wordObj.word.charAt(i);
				var unAccented = SuperDiff.deaccentChar(rawText);
				var bareAccent = DictationDiff.reverseAccentMap[rawText];
				var $char = $('<span>').addClass('letter').text(rawText).appendTo($word);
				if (h) $char.addClass('hinted');
				if (accentHintedFlags[i] && rawText != unAccented && !!bareAccent) {
					var $accent = $('<span class="accent">').text(bareAccent);
					if (bareAccent == '˜') $accent.addClass('tilde');
					$char.append($accent);
				}
			});
			return $cont;
		},
		wordListWithHighlighting: function(q, highlightMap, hideHints) {
			var $list = $('<div>');
			var me = this;
			var words = q.getVisibleWords().forEach(function(w, i) {
				var hints = q.history && q.history.hints[i]  // bug fix to handle when captions change
					? q.history.hints[i][q.history.hints[i].length-1]
					: q.hintRecord[i];
				var accentHints = q.history && q.history.accentHints[i]
					? q.history.accentHints[i][q.history.accentHints[i].length-1]
					: q.accentHintRecord[i];
				var hasHints = hints.some(function(h){ return h; });
				var hasAccentHints = accentHints.some(function(h){ return h; });
				var $w = (!hideHints && (hasHints || hasAccentHints)) ? me.wordWithHinting(w, hints, accentHints) : me.wrapWord(w);
				if (!!highlightMap[i])
					$w.find('.word').addClass('highlight');
				$list.append($w);
			});
			return $list;
		},
	};

	function DictationFeedbackInput(opts) { this.init(opts); }
	$.extend(DictationFeedbackInput.prototype, {
		init: function(opts) {
			this.question = null;

			this.options = $.extend({
				onInput: false,
				onCompletionByUser: false,
				onWordClick: false,
				onMistakeClick: false,
				onAccentMistakeClick: false,
				onDoubleSubmit: false,
				onMissingLetter: false,
				onMissingCorrected: false,
				onMistake: false,
				onMistakeCorrected: false,
				onAccentMistake: false,
				onAccentMistakeCorrected: false,
				shadowChecking: false,
				shadowCheckingAggressive: false,
				blockPaste: false,
			}, opts);

			this.$input = $('#dictation_input');
			this.$inputGroup = $('#dictation_controls .input_group');
			this.$feedback = $('#dictation_feedback');
			this.$measurer = $('#feedback_measurer');
			this.$form = $('#dictation_field form');

			var me = this;

			var keysToGradeOn = {
				32: "spacebar",
				33: '!',
				34: '"',
				44: ',',
				46: '.',
				58: ':',
				59: ';',
				63: '?'
			};

			this.$input.on('input', function(e) {
				me.options.onInput && me.options.onInput();
				setTimeout(function(){
					me.check()
				},0)
			});

			if (this.options.blockPaste) {
				this.$input.on('paste', false);
			}

			// this take the place of enter
			this.$form.on('submit', function(e) {
				e.preventDefault();
				var really_did_check = me.check();
				if( !really_did_check ) {
					me.options.onDoubleSubmit && me.options.onDoubleSubmit();
				}
			});

			if (this.options.onCompletionByUser) {
				this.options.onCompletionByUser = this.options.onCompletionByUser.bind(this);
			}

			if (this.options.onLastWordCompletion) {
				this.options.onLastWordCompletion = this.options.onLastWordCompletion.bind(this);
			}

			if (this.options.onInput) {
				this.options.onInput = this.options.onInput.bind(this);
			}

			if (this.options.onDisabledInput) {
				this.options.onDisabledInput = this.options.onDisabledInput.bind(this);
			}

			this.$feedback.on('click touchend', '.letter.soft_swap', function(e) {
				e.preventDefault();
				var $c = $(this).closest('.correction');
				var word_index = me.$feedback.find('.correction').index( $c );
				var letter_index = $c.find('.letter').index(this);
				var corrected_letter = me.question.getCorrectLetterInWord(letter_index,word_index);

				var flip_duration = $('body').hasClass('chinese') ? 0 : 600;
				$(this).flipTo(corrected_letter, {
					onComplete:function(){
						me.options.onAccentMistakeClick && me.options.onAccentMistakeClick(e, me.question, letter_index, word_index);
					},
					animationDuration: flip_duration
				});
			});

			if(this.options.onWordClick) {
				this.$feedback.on('click touchend','.correction',function(e){
					e.preventDefault();
					var index = me.$feedback.find('.correction').index(this);
					me.options.onWordClick(e, me.question, this, index);
				});
			}

			if (this.options.onMistakeClick) {
				this.$feedback.on('click touchend','.correction.fuzzy_match .letter:not(.match,.soft_swap)', function(e) {
					e.preventDefault();
					var $letter = $(this);
					var $word = $letter.parents('.correction');
					me.options.onMistakeClick(e, me.question, $letter.index(), $word.index());
				});
			}

			if(this.options.shadowChecking) {
				this.$input.on('input',function(e){
					me.shadowCheck();
				});
			}

			this._shadow_check_last_text = '';
			this._shadow_check_last_counts = { matchCount: 0, accentErrors: 0, inputCount: 0 };
			this._shadow_check_last_cost = Infinity;
		},
		setQuestion: function(q) {
			this.question = q;
			this._last_checked_input_text = null;
			this._shadow_check_last_text = '';
			this._shadow_check_last_counts = { matchCount: 0, accentErrors: 0, inputCount: 0 };
			this._shadow_check_last_cost = Infinity;
			this.$input.val(this.question.last_response);
			this.$measurer.text( this.question.getVisibleText() );
			this.check(true);
			this.$feedback.add('.correct_errors_instructions').removeClass('needs_instructions post_last_word_complete_action');
		},
		renderKeyboardHelper:function(lang_id,device) {
			this.$input.attr('lang', lang_id);

			var $container = $('.minikeyboard_dictation_container').empty();

			if(device.is_ipad || device.is_android || device.is_iphone) {
				$container.html(''
								+ '<div class="touch_tip">'
								+ 'Tip:  hold down the letter to access accented characters'
								+ '</div>');
			} else if(lang_id.substr(0,2) !== 'zh') {
				new LarkLanguages.MiniKeyboard(this.$input,$container,lang_id, function onInsert(toInsert, selectionRange) {
					Logger.log("---- clicked minikeyboard to insert '"+toInsert
							   +"'; original selection range was from "+selectionRange.from+" to "+selectionRange.to);
				});
			} else if (lang_id == 'zh_CN_US') {
				$container.html('Use 1,2,3,4,5 to type pinyin tones.  v = ü');
			}
		},
		wordIndexOfCursor: function() {
			var r = this.$input.val();
			var i = this.$input[0];
			var res = null;
			if(i.selectionStart == i.selectionEnd) {
				var pos = i.selectionStart;
				if( r.substr(pos-1,1) == ' ' ) {
					// just typed a space -- compensate in one direction or the other
					if (pos == r.length - 1) {
						pos--;
					} else {
						pos++;
					}
				}

				var substr = r.substr(0,pos);
				substr = substr.replace(new RegExp('\\s+'+DictationDiff.punctuationCharacterClass+'+(?=\\s+)', 'gim'), ' ');
				var res = substr.replace(/\s+/g,' ').trim().split(' ').length - 1;

				return res;
			}
			return;
		},
		shadowCheck: function() {
			/*
				check() is normally called on Enter and spacebar, and some other punctation.
				this runs checking in the background, and auto calls check() in the following cases:
				1) if the cursor is not at the end, and a word is fixed, then call check().
				2) if the caption is fully completed
				3) deleting a word should call check
				4) (optional) Call check anytime a word is completed, or an accent is fixed
			*/
			var t = this.$input.val();
			if(t !== this._shadow_check_last_text) {  // text has changed?
				var diff_data = this.question.getNewDiff(t);

				var counts = diff_data.counts();
				var cost = diff_data.combined_diff.reduce(function(c, d) {
					return c + ((d.sub_diff) ? d.sub_diff.reduce(function(c, sd){ return c+sd[4]; }, 0) : 0);
				}, 0);
				var cursor_is_at_end = this.$input[0].selectionStart >= t.length;

				if (counts.matchCount > this._shadow_check_last_counts.matchCount ||
					counts.accentErrors !== this._shadow_check_last_counts.accentErrors) {
						// a word was fully corrected or an accent mistake was made / corrected
						this.check();
					} else if ( counts.wordCount === counts.matchCount ) {
						// the whole phrase is correct
						this.check();
					} else if ( counts.inputCount < this._shadow_check_last_counts.inputCount  )  {
						// a word was removed
						this.check();
					} else if ( this.options.shadowCheckingAggressive &&
							   (counts.inputCount == this._shadow_check_last_counts.inputCount && cost < this._shadow_check_last_cost) ) {
								   // no new words, but the cost has decreased (i.e. a correction has been made)
								   this.check();
							   }

							   if (counts.deleteCount < this._shadow_check_last_counts.deleteCount)
								   this.showFeedbackFromDiff(diff_data);
							   else if (counts.deleteCount == this._shadow_check_last_counts.deleteCount && cost < this._shadow_check_last_cost)
								   this.showFeedbackFromDiff(diff_data);
							   this._shadow_check_last_cost = cost;
							   this._shadow_check_last_text = t;
							   this._shadow_check_last_counts = counts;
			}
		},
		check: function(is_initial_check, is_hint, is_accent_hint) {
			var input_text = this.$input.val();
			if(input_text === this._last_checked_input_text) {
				return false;
			}

			Logger.log("---- checking '"+input_text+"'");

			var initialMistakeCount = this.$feedback.find('.swap, .delete').length;
			var initialMissingCount = this.$feedback.find('.missing').length;
			var initialAccentCount = this.$feedback.find('.soft_swap').length;

			this.question.gradeResponse( input_text, this.wordIndexOfCursor(), !!is_hint, !!is_accent_hint );
			this._last_checked_input_text = input_text;

			this.$feedback.html( this.question.getFeedbackMarkup() );

			if(!is_initial_check) {
				var $mistakes = this.$feedback.find('.swap, .delete');
				var $missing = this.$feedback.find('.missing');
				var $accents = this.$feedback.find('.soft_swap');
				$mistakes.length && this.options.onMistake && this.options.onMistake($mistakes);
				$missing.length && this.options.onMissingLetter && this.options.onMissingLetter($missing);
				$accents.length && this.options.onAccentMistake && this.options.onAccentMistake($accents);

				($mistakes.length < initialMistakeCount) && this.options.onMistakeCorrected && this.options.onMistakeCorrected();
				($missing.length  < initialMissingCount) && this.options.onMissingCorrected && this.options.onMissingCorrected();
				($accents.length  < initialAccentCount)  && this.options.onAccentMistakeCorrected && this.options.onAccentMistakeCorrected();

				this.question.isLastWordComplete() && this.options.onLastWordCompletion && this.options.onLastWordCompletion();
				this.question.isComplete() && this.options.onCompletionByUser && this.options.onCompletionByUser();
			}
			return true;
		},
		showFeedbackFromDiff: function(diff) { this.$feedback.html( diff.feedbackHTML() ); },
		focusInput: function() { this.$input.focus(); },
		blurInput: function() { this.$input.blur(); },
		disableInput: function() {
			var me = this;
			this.$input.on('keydown.temp_disable',function(e) {
				Logger.log(" ** disabled input **");
				e.preventDefault();
				e.stopPropagation();

				me.blurInput();
				me.options.onDisabledInput && me.options.onDisabledInput(e.which, e);
			});
		},
		enableInput: function() { this.$input.off('keydown.temp_disable'); },
		enablePinyinMode: function() { this.$input.enable_pinyin_input(); },
		disablePinyinMode: function() { this.$input.disable_pinyin_input(); },

		visibleWordAtDiffIndex: function(wordIndex) { return this.question.visibleWordAtDiffIndex(wordIndex); },
		hintWordAtIndex: function(wordIndex, hintProportion) {
			var q = this.question;
			q.refreshDiff(this.wordIndexOfCursor());
			this.$input.val(q.hintWordAtIndex(wordIndex, hintProportion)).trigger("input");
			this.$input.focus();
			var revealLength = Math.ceil(this.visibleWordAtDiffIndex(wordIndex).word.length * hintProportion);
			var newCursorPos = q.cursorPositionForWordAtDiffIndex(wordIndex) + revealLength;
			this.$input[0].setSelectionRange(newCursorPos, newCursorPos);

			this.check(false, true);
		},
		revealWordAtIndex: function(wordIndex) {
			var new_text = this.question.revealWordAtIndex(wordIndex);
			this.$input.val(new_text).trigger("input");
			this.check();
		},
		removeWordAtIndex: function(wordIndex) {
			var q = this.question;
			var new_text = q.removeWordAtIndex(wordIndex);
			this.$input.val(new_text).trigger("input");
			this.$input.focus();
			var newCursorPos = q.cursorPositionForWordAtDiffIndex(wordIndex);
			this.$input[0].setSelectionRange(newCursorPos, newCursorPos);

			this.check();
		},
		fixLetterInWord: function(letterIndex, wordIndex, notAccent) {
			var q = this.question;
			q.refreshDiff(this.wordIndexOfCursor());
			this.$input.val(q.fixLetterInWord(letterIndex, wordIndex, notAccent)).trigger("input");
			this.$input.focus();
			var newCursorPos = q.cursorPositionForWordAtDiffIndex(wordIndex, letterIndex);
			this.$input[0].setSelectionRange(newCursorPos, newCursorPos);

			this.check(false, notAccent, !notAccent);
		},
		resizeInputForContainerWidth: function(gameWidth) {
			// find largest font size which will not wrap
			var fontSize = 1,
				currentFontSize = 1;
				this.$measurer.css('font-size', currentFontSize+'em');
				var textWidth = this.$measurer.outerWidth();
				while (textWidth + 60 >= gameWidth) {
					currentFontSize-=0.1;
					this.$measurer.css('font-size', currentFontSize+'em');
					textWidth = this.$measurer.outerWidth();
				}

				// set all three displayed text lines to use the found font size
				this.$inputGroup.css('font-size', currentFontSize+'em');
				this.$feedback.css('font-size', currentFontSize+'em');
				this.$measurer.css('font-size', currentFontSize+'em');

				// resize the input field so it matches (roughly) the feedback size
				var widthDiff = gameWidth - textWidth;
				this.$form.find('.input_group').css({
					'margin-right': widthDiff / 2-12.5,
					'margin-left': widthDiff / 2-12.5
				});
		},

		// view components
		$nthWordElement: function(pos) { return $( this.$feedback.children().get(pos) ); },
		$words: function() { return this.$feedback.find('.correction'); },

	});

  // volume slider
	function DictationVolumeSlider(elt, callbacks) { this.init(elt, callbacks); }
	$.extend(DictationVolumeSlider.prototype, {
		init: function(elt, callbacks) {
			// save queries and callback
			this.$e = elt;
			this.$handle = this.$e.find('.handle');
			this.onVolumeChange = callbacks.onVolumeChange || function() {};
			this.onButtonClick = callbacks.onButtonClick || function() {};

			// make slider visible for measurements
			this.$e.addClass('open');

			// make measurements and save track height
			var $track = this.$e.find('.track');
			this.trackHeight = $track.height();
			this.trackTop = $track.offset().top;

			// hide the slider again
			this.$e.removeClass('open');

			// setup drag handlers
			var me = this;
			this.dragging = false;
			this.mouseStartY = false;
			this.handleStartY = false;

			this.$e.on('mousedown', function(e) {
				me.trackHeight = $track.height();
				me.trackTop = $track.offset().top;
				me.mouseStartY = e.pageY;
				me.handleStartY = e.pageY - me.trackTop;
				$('body').on('mousemove.volumeslider', function(e) {
					me.dragging = true;
					me.$e.addClass('open');
					var deltaY = e.pageY - me.mouseStartY;
					var newY = me.handleStartY + deltaY;
					me.onVolumeChange(me._setValue(newY));
				});
				$('body').on('mouseup.volumeslider', function(e) {
					me.dragging = false;
					me.$e.removeClass('open');
					me.mouseStartY = false;
					$('body').off('.volumeslider');
				});
			});
			this.$e.on('mouseup', function(e) {
				if (!me.dragging) {
					// call this a click
					if (e.pageY <= (me.trackHeight+me.trackTop)) {
						// click is in the slider
						me.onVolumeChange(me._setValue(e.pageY - me.trackTop));
					} else {
						// click is on the button
						me.onButtonClick();
					}
				}
				me.dragging = false;
			});
		},
		setVolume: function(vol) {
			if (!this.dragging) {
				this._setValue(this.trackHeight - vol*this.trackHeight);
			}
			if (vol > 0) {
				this.$e.removeClass('muted');
			} else {
				this.$e.addClass('muted');
			}
		},
		_setValue: function(val) {
			var clamped = $.clamp(val, 0, this.trackHeight);
			this.$handle.css({top: clamped});
			return (this.trackHeight - clamped)/this.trackHeight;
		},
	});



  // slow mode of the video: 100%, 75%, and 50%
	function DictationRateSelector(elt, rateOptions, callbacks) { this.init(elt, rateOptions || [1], callbacks); }
	$.extend(DictationRateSelector.prototype, {
		init: function(elt, rateOptions, callbacks) {
			this.$e = elt;
			this.$opts = this.$e.find('.options').empty();
			this.optLookup = {};
			this.oldRate = rateOptions.length > 2 ? rateOptions[rateOptions.length-2] : rateOptions[0];

			// save callbacks
			this.onRateChange = this.defaultCallback(callbacks, 'onRateChange');
			this.onButtonClick = this.defaultCallback(callbacks, 'onButtonClick');

			var me = this;

			// build options
			rateOptions.forEach(function(r) {
				var $newOpt = $('<li class="option">').text((r*100)+'%').data('rate', r);
				me.optLookup[r] = $newOpt;
				me.$opts.append($newOpt);
			});

			// bind options
			this.$opts.on('click touchend', '.option', function() { me.onRateChange($(this).data('rate')); });

			// bind button
			this.$e.find('.button_content').on('click touchend', this.onButtonClick);

			// hide the popup if there are only two (or fewer) options
			if (rateOptions.length <= 2) {
				this.$e.addClass('no_options');
			}
		},
		setRate: function(rate) {
			if ((rate < 1 && this.currentRate >= 1) || (rate >= 1 && this.currentRate < 1)) {
				this.oldRate = this.currentRate;
			}
			this.currentRate = rate;

			this.$opts.find('.option.active').removeClass('active');
			this.optLookup[rate] && this.optLookup[rate].addClass('active');

			this.$e[(rate < 1) ? 'addClass' : 'removeClass']('active');
		},
	}, default_callback_mixin);

})(jQuery);

"use strict";

var event_mixin = {
	bind: function() { $.fn.on.apply($(this), Array.prototype.slice.apply(arguments)); return this; },
	trigger: function() { $.fn.trigger.apply($(this), Array.prototype.slice.apply(arguments)); return this; },
	triggerHandler: function() { $.fn.triggerHandler.apply($(this), Array.prototype.slice.apply(arguments)); return this; },
	unbind: function() { $.fn.off.apply($(this), Array.prototype.slice.apply(arguments)); return this; }
};

var LarkLanguages = (function($) {

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


function CaptionDisplay(vc,captions,app){
	this.init(vc,captions,app);
}
$.extend(CaptionDisplay.prototype,{
	init: function(vc,captions,app) {
		this.vc = vc;
		this.captions = captions;
		this.app = app
		var me = this;

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

		this.$e = $('body');

		var captions = $.extend(CAPTIONS,caption_methods);

		function constructorForSource(source) {
			switch (source) {
				default: return VideoController;
			}
		}
		var constructor = constructorForSource(VIDEO_HOST);
		var vc = this.vc = new constructor(VIDEO_URL,captions,VIDEO_RANGE);

		// we don't actually need references to these
		var captionDisplay = new CaptionDisplay(vc,captions,this);
		new ScrubBar(vc,captions);
		
		this.playbackControls = new PlaybackControls(vc,captions,this);

		var me = this;

		this.window_is_active_tab = true;
	},
	getActiveController: function() {
		var active_controller;
		active_controller = this.playbackControls;
		return active_controller;
	},
	_nearestDivisibleBy:function(n,d) {
		var r = n % d;
		var d2 = d/2;
		var v = r > d2 ? n + (d - r) : n - r;
		v = Math.round(v);
		return v;
	}
}, event_mixin);


return {

	// Video Controllers & View Elements
	VideoController: VideoController,
	ScrubBar: ScrubBar,
	PlaybackControls: PlaybackControls,

	// Other non-game interface elements
	CaptionDisplay: CaptionDisplay,

	// Application Code
	Application: Application,
};

})(jQuery);
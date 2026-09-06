import Clutter from 'gi://Clutter';

export const AnimationMode = {
    EASE_OUT_QUAD: Clutter.AnimationMode.EASE_OUT_QUAD,
    EASE_OUT_CUBIC: Clutter.AnimationMode.EASE_OUT_CUBIC,
    EASE_IN_OUT_QUAD: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
};

export function animatePill(actor, { width, height, opacity, scale, duration = 260, mode = Clutter.AnimationMode.EASE_OUT_CUBIC, onComplete } = {}) {
    if (!actor) return;

    actor.remove_all_transitions();

    const params = {
        duration,
        mode,
        onComplete: onComplete || null,
    };

    if (width !== undefined) params.width = width;
    if (height !== undefined) params.height = height;
    if (opacity !== undefined) params.opacity = opacity;
    if (scale !== undefined) {
        params.scale_x = scale;
        params.scale_y = scale;
    }

    actor.ease(params);
}

export function fadeIn(actor, duration = 200) {
    if (!actor) return;
    actor.opacity = 0;
    actor.show();
    actor.ease({
        opacity: 255,
        duration,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
}

export function fadeOut(actor, duration = 180, onComplete) {
    if (!actor) return;
    actor.ease({
        opacity: 0,
        duration,
        mode: Clutter.AnimationMode.EASE_IN_QUAD,
        onComplete: () => {
            actor.hide();
            if (onComplete) onComplete();
        },
    });
}

export function crossFade(oldActor, newActor, duration = 200) {
    if (oldActor) {
        oldActor.ease({
            opacity: 0,
            duration: duration * 0.7,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => oldActor.hide(),
        });
    }
    if (newActor) {
        newActor.opacity = 0;
        newActor.show();
        // slight delay for smoother crossfade
        newActor.ease({
            opacity: 255,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            delay: oldActor ? 60 : 0,
        });
    }
}

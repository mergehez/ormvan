/**
 * A host's provider boots whatever lives in its `app/models`; these example models live in `tests/support`, so
 * their column metadata has to be booted explicitly before the engine looks at it.
 */
import { Cache, ChatMessage, Topic, TopicRating, User, UserRating } from './models.js';

export async function bootExampleModels(): Promise<void> {
    await Promise.all([User.boot(), Topic.boot(), ChatMessage.boot(), Cache.boot(), TopicRating.boot(), UserRating.boot()]);
}

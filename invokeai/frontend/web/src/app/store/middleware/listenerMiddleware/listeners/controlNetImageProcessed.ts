import { startAppListening } from '..';
import { imageMetadataReceived } from 'services/thunks/image';
import { log } from 'app/logging/useLogger';
import { controlNetImageProcessed } from 'features/controlNet/store/actions';
import { Graph } from 'services/api';
import { sessionCreated } from 'services/thunks/session';
import { sessionReadyToInvoke } from 'features/system/store/actions';
import { socketInvocationComplete } from 'services/events/actions';
import { isImageOutput } from 'services/types/guards';
import { controlNetProcessedImageChanged } from 'features/controlNet/store/controlNetSlice';
import { pick } from 'lodash-es';

const moduleLog = log.child({ namespace: 'controlNet' });

export const addControlNetImageProcessedListener = () => {
  startAppListening({
    actionCreator: controlNetImageProcessed,
    effect: async (
      action,
      { dispatch, getState, take, unsubscribe, subscribe }
    ) => {
      const { controlNetId } = action.payload;
      const controlNet = getState().controlNet.controlNets[controlNetId];

      if (!controlNet.controlImage) {
        moduleLog.error('Unable to process ControlNet image');
        return;
      }

      // ControlNet one-off procressing graph is just the processor node, no edges.
      // Also we need to grab the image.
      const graph: Graph = {
        nodes: {
          [controlNet.processorNode.id]: {
            ...controlNet.processorNode,
            is_intermediate: true,
            image: pick(controlNet.controlImage, ['image_name']),
          },
        },
      };

      // Create a session to run the graph & wait til it's ready to invoke
      const sessionCreatedAction = dispatch(sessionCreated({ graph }));
      const [sessionCreatedFulfilledAction] = await take(
        (action): action is ReturnType<typeof sessionCreated.fulfilled> =>
          sessionCreated.fulfilled.match(action) &&
          action.meta.requestId === sessionCreatedAction.requestId
      );

      const sessionId = sessionCreatedFulfilledAction.payload.id;

      // Invoke the session & wait til it's complete
      dispatch(sessionReadyToInvoke());
      const [invocationCompleteAction] = await take(
        (action): action is ReturnType<typeof socketInvocationComplete> =>
          socketInvocationComplete.match(action) &&
          action.payload.data.graph_execution_state_id === sessionId
      );

      // We still have to check the output type
      if (isImageOutput(invocationCompleteAction.payload.data.result)) {
        const { image_name } =
          invocationCompleteAction.payload.data.result.image;

        // Wait for the ImageDTO to be received
        const [imageMetadataReceivedAction] = await take(
          (
            action
          ): action is ReturnType<typeof imageMetadataReceived.fulfilled> =>
            imageMetadataReceived.fulfilled.match(action) &&
            action.payload.image_name === image_name
        );
        const processedControlImage = imageMetadataReceivedAction.payload;

        moduleLog.debug(
          { data: { arg: action.payload, processedControlImage } },
          'ControlNet image processed'
        );

        // Update the processed image in the store
        dispatch(
          controlNetProcessedImageChanged({
            controlNetId,
            processedControlImage,
          })
        );
      }
    },
  });
};

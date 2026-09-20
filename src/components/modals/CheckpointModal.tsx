import React from 'react';
import { useModalStore } from '../../lib/stores';
import { Modal, ModalBody, ModalHeader } from '../ui';
import { CheckpointTimeline } from '../editor/CheckpointTimeline';

export const CheckpointModal: React.FC = () => {
    const closeModal = useModalStore(s => s.closeModal);
    const activeModal = useModalStore(s => s.activeModal);
    return (
        <Modal open={activeModal === 'checkpoint'} onClose={closeModal} size="large" modifier="checkpoint-modal">
            <ModalHeader title="Checkpoints" onClose={closeModal} />
            <ModalBody className="checkpoint-modal__body">
                {activeModal === 'checkpoint' && <CheckpointTimeline />}
            </ModalBody>
        </Modal>
    );
};
